import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";
import { Leader } from "../dist/leader.js";
import { Follower } from "../dist/follower.js";
import { health, request, sleep, stateDirectory } from "../dist/runtime.js";
import { stopBridge } from "../dist/manager.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const indexPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const state = await mkdtemp(path.join(os.tmpdir(), "figma-runtime-"));
process.env.FIGMA_BRIDGE_STATE_DIR = state;

test("Windows default state stays outside virtualized AppData; explicit override wins", () => {
  const original = process.env.FIGMA_BRIDGE_STATE_DIR;
  try {
    delete process.env.FIGMA_BRIDGE_STATE_DIR;
    if (process.platform === "win32")
      assert.equal(stateDirectory(), path.join(os.homedir(), ".figma-mcp-bridge"));
    process.env.FIGMA_BRIDGE_STATE_DIR = state;
    assert.equal(stateDirectory(), path.resolve(state));
  } finally {
    if (original === undefined) delete process.env.FIGMA_BRIDGE_STATE_DIR;
    else process.env.FIGMA_BRIDGE_STATE_DIR = original;
  }
});

test("different credential stores are diagnosed without takeover or credential replacement", async (t) => {
  const port = await freePort();
  t.after(() => stopBridge(port));
  const started = await cli(port, ["bridge", "start"]);
  const original = await readFile(path.join(state, `auth-${port}`));
  const alternate = await mkdtemp(path.join(os.tmpdir(), "figma-alternate-state-"));
  const rejected = await cli(port, ["bridge", "start"], undefined, {
    FIGMA_BRIDGE_STATE_DIR: alternate,
  });
  assert.equal(rejected.code, 3);
  assert.equal(rejected.result.error.code, "UNAUTHORIZED");
  assert.equal(rejected.result.error.details.stateDirectory, alternate);
  assert.equal(rejected.result.error.details.port, port);
  assert.match(rejected.result.error.message, /状态目录/);
  assert.equal(JSON.stringify(rejected.result).includes(original.toString()), false);
  assert.ok(original.equals(await readFile(path.join(state, `auth-${port}`))));
  assert.equal(
    (await cli(port, ["bridge", "status"])).result.data.instanceId,
    started.result.data.instanceId
  );
});

test("CLI waits for reconnection before dispatch and sends a write only once", async (t) => {
  const port = await freePort();
  t.after(() => stopBridge(port));
  await cli(port, ["bridge", "start"]);
  let calls = 0;
  const result = cli(port, ["call", "create_frame", "--input", "-", "--connect-timeout", "3"], {
    name: "Reconnect",
  });
  await sleep(700);
  const ws = await plugin(port, "reconnected", () => {
    calls++;
    return { id: "1:2" };
  });
  t.after(() => ws.close());
  const completed = await result;
  assert.equal(completed.code, 0, JSON.stringify(completed));
  assert.equal(calls, 1);
});

test("application heartbeat negotiates and does not prevent daemon idle exit", async () => {
  const port = await freePort();
  await cli(port, ["bridge", "start"], undefined, { FIGMA_BRIDGE_IDLE_MS: "1200" });
  const ws = new WebSocket(`ws://localhost:${port}/ws?fileKey=heartbeat`);
  await once(ws, "open");
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "bridge-hello" }));
  assert.equal(JSON.parse(String((await ready)[0])).type, "bridge-ready");
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "bridge-ping" }));
  }, 100);
  try {
    await Promise.race([
      once(ws, "close"),
      sleep(5000).then(() => {
        throw new Error("heartbeat prevented idle exit");
      }),
    ]);
    assert.equal(await health(port), null);
  } finally {
    clearInterval(timer);
    ws.terminate();
    await stopBridge(port);
  }
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function cli(port, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--port", String(port), ...args], {
      windowsHide: true,
      env: { ...process.env, FIGMA_BRIDGE_IDLE_MS: "60000", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = stdout;
      }
      resolve({ code, result, stderr });
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
async function plugin(
  port,
  key,
  handler = (req) => ({ fileKey: key, type: req.type, params: req.params })
) {
  const ws = new WebSocket(
    `ws://localhost:${port}/ws?fileKey=${encodeURIComponent(key)}&fileName=SameName`
  );
  ws.on("message", async (bytes) => {
    const req = JSON.parse(String(bytes));
    const data = await handler(req, ws);
    if (data !== undefined && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data }));
  });
  await once(ws, "open");
  return ws;
}

test("offline CLI commands do not start a daemon and errors have stable exit codes", async () => {
  const port = await freePort();
  const tools = await cli(port, ["tools", "list"]);
  assert.equal(tools.result.data.length, 39);
  assert.equal(await health(port), null);
  const description = await cli(port, ["tools", "describe", "create_frame"]);
  assert.equal(description.result.data.inputSchema.type, "object");
  assert.equal(
    (await cli(port, ["call", "create_frame", "--input", "-", "--file-key", "a"], { fileKey: "b" }))
      .result.error.code,
    "FILE_KEY_CONFLICT"
  );
  assert.equal((await cli(port, ["call", "get_node", "--input", "-"], { nodeId: "bad" })).code, 2);
  assert.equal(await health(port), null);
  assert.equal((await cli(port, ["skills", "show"])).result.ok, true);
  assert.match((await cli(port, ["--help"])).result, /用法/);
});

test("concurrent cold starts reuse one daemon after CLI exits; stop validates identity", async (t) => {
  const port = await freePort();
  t.after(async () => {
    await stopBridge(port).catch(() => {});
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () => cli(port, ["bridge", "start"]))
  );
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(new Set(results.map((r) => r.result.data.instanceId)).size, 1);
  const initial = await health(port);
  assert.ok(initial);
  // Stale manifest is never trusted as authority for an existing process.
  await writeFile(
    path.join(state, `daemon-${port}.json`),
    JSON.stringify({ pid: process.pid, instanceId: "stale", startedAt: "old" })
  );
  assert.equal((await cli(port, ["bridge", "start"])).result.data.instanceId, initial.instanceId);
  await assert.rejects(request(port, "/control/stop", { instanceId: "wrong" }), {
    code: "INSTANCE_CHANGED",
  });
  assert.equal((await health(port)).instanceId, initial.instanceId);
  const denied = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    body: JSON.stringify({ tool: "list_files" }),
  });
  assert.equal(denied.status, 401);
  assert.equal((await cli(port, ["bridge", "stop"])).code, 0);
  assert.equal(await health(port), null);
});

test("real HTTP/WebSocket routing distinguishes same-name files and reconnects", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli" });
  await leader.start();
  t.after(() => leader.stop());
  const first = await plugin(port, "unsaved-one"),
    second = await plugin(port, "unsaved-two");
  t.after(() => {
    first.terminate();
    second.terminate();
  });
  const ambiguous = await cli(port, ["call", "get_document", "--input", "-"], {});
  assert.equal(ambiguous.result.error.code, "FILE_REQUIRED");
  const specific = await cli(
    port,
    ["call", "get_document", "--input", "-", "--file-key", "unsaved-two"],
    {}
  );
  assert.equal(specific.result.data.fileKey, "unsaved-two");
  const missing = await cli(
    port,
    ["call", "get_document", "--input", "-", "--file-key", "cloud-url-key"],
    {}
  );
  assert.equal(missing.result.error.code, "FILE_NOT_CONNECTED");
  first.close();
  await once(first, "close");
  const replacement = await plugin(port, "unsaved-new");
  t.after(() => replacement.terminate());
  assert.equal((await new Follower(`http://localhost:${port}`).listConnectedFiles()).length, 2);
});

test("disconnected write reports unknown outcome without replay", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli" });
  await leader.start();
  t.after(() => leader.stop());
  let count = 0;
  const socket = await plugin(port, "file", (_req, ws) => {
    count++;
    ws.close();
  });
  t.after(() => socket.terminate());
  const result = await cli(port, ["call", "create_frame", "--input", "-"], { name: "only once" });
  assert.equal(result.result.error.code, "OUTCOME_UNKNOWN");
  assert.equal(result.code, 5);
  assert.equal(count, 1);
});

test("active requests block stop and idle exit; pings do not keep an idle bridge alive", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli", idleMs: 250 });
  await leader.start();
  t.after(() => leader.stop());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  const socket = await plugin(port, "file", async () => {
    arrived();
    await gate;
    return { done: true };
  });
  t.after(() => socket.terminate());
  const pending = new Follower(`http://localhost:${port}`).send("get_document");
  await waiting;
  await assert.rejects(stopBridge(port), { code: "BUSY" });
  await sleep(400);
  assert.ok(await health(port));
  release();
  await pending;
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!(await health(port))) break;
  }
  assert.equal(await health(port), null);
});

test("foreign listener is not accepted or terminated", async (t) => {
  const server = http.createServer((_req, res) =>
    res.end(JSON.stringify({ status: "ok", version: "old" }))
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const result = await cli(port, ["bridge", "start"]);
  assert.equal(result.result.error.code, "INCOMPATIBLE_BRIDGE");
  assert.equal((await fetch(`http://127.0.0.1:${port}/ping`)).status, 200);
});

test("a crashed managed daemon and its abandoned lock recover with a new identity", async (t) => {
  const port = await freePort();
  t.after(async () => {
    await stopBridge(port).catch(() => {});
  });
  const started = await cli(port, ["bridge", "start"]);
  assert.equal(started.code, 0);
  const initial = started.result.data;
  assert.equal((await health(port)).instanceId, initial.instanceId);
  // Only kill the daemon this test just created on its private, allocated port.
  process.kill(initial.pid, "SIGKILL");
  for (let i = 0; i < 50; i++) {
    await sleep(50);
    if (!(await health(port).catch(() => true))) break;
  }
  assert.equal(await health(port), null);
  await writeFile(
    path.join(state, `bridge-${port}.lock`),
    JSON.stringify({ pid: initial.pid, nonce: "abandoned", createdAt: 0 })
  );
  const recovered = await cli(port, ["bridge", "start"]);
  assert.equal(recovered.code, 0);
  assert.notEqual(recovered.result.data.instanceId, initial.instanceId);
});

test("real stdio MCP stays compatible and shares a leader with CLI", async (t) => {
  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [indexPath],
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(port) },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({ name: "acceptance", version: "1" });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 39);
  const socket = await plugin(port, "mcp-file");
  t.after(() => socket.terminate());
  const a = await client.callTool({
    name: "set_text_content",
    arguments: { nodeId: "1:2", characters: "alias" },
  });
  const b = await cli(port, ["call", "set_text_content", "--input", "-"], {
    nodeId: "1:2",
    characters: "alias",
  });
  assert.deepEqual(JSON.parse(a.content[0].text), b.result.data);
  assert.equal((await cli(port, ["bridge", "stop"])).result.error.code, "NOT_OWNED");
});

test("wait respects its timeout even when a connected plugin never responds", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli" });
  await leader.start();
  t.after(() => leader.stop());
  const socket = await plugin(port, "silent", () => undefined);
  t.after(() => socket.terminate());
  const started = Date.now();
  const result = await cli(port, ["wait", "--timeout", "0.3"]);
  assert.equal(result.code, 4);
  assert.equal(result.result.error.code, "TIMEOUT");
  assert.ok(Date.now() - started < 4000);
});

test("direct MCP requests are counted and another socket cannot answer them", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli" });
  await leader.start();
  t.after(() => leader.stop());
  let receive;
  const arrived = new Promise((resolve) => {
    receive = resolve;
  });
  const first = await plugin(port, "first", (message) => {
    receive(message);
  });
  const second = await plugin(port, "second");
  t.after(() => {
    first.terminate();
    second.terminate();
  });
  let settled = false;
  const pending = leader
    .sendWithParams("get_document", undefined, undefined, "first")
    .then((value) => {
      settled = true;
      return value;
    });
  const message = await arrived;
  assert.equal((await request(port, "/control/status")).inFlight, 1);
  await assert.rejects(stopBridge(port), { code: "BUSY" });
  second.send(
    JSON.stringify({ requestId: message.requestId, type: message.type, data: "wrong file" })
  );
  await sleep(50);
  assert.equal(settled, false);
  first.send(
    JSON.stringify({ requestId: message.requestId, type: message.type, data: "right file" })
  );
  assert.equal((await pending).data, "right file");
});

test("incomplete HTTP responses are transport uncertainty, not confirmed write failure", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"data":');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  await assert.rejects(request(server.address().port, "/rpc", { tool: "create_frame" }), {
    code: "CONNECTION_LOST",
  });
});
