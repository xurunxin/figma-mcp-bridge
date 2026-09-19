import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { Leader } from "../dist/leader.js";
import { request } from "../dist/runtime.js";
import { pageProbe } from "../../research/chrome-extension/probes.js";

process.env.FIGMA_BRIDGE_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "figma-research-"));
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const origin = `chrome-extension://${"a".repeat(32)}`;

test("research is opt-in, authenticated, isolated from files, and routes read-only probes", async (t) => {
  const port = await freePort(),
    leader = new Leader(port, { owner: "cli" });
  await leader.start();
  t.after(() => leader.stop());
  assert.equal((await request(port, "/research/status")).enabled, false);
  const rejected = new WebSocket(`ws://127.0.0.1:${port}/research/ws`, { origin });
  await once(rejected, "error");
  const setup = await request(port, "/research/setup", {});
  const wrong = new WebSocket(setup.wsUrl, { origin });
  await once(wrong, "open");
  wrong.send(JSON.stringify({ type: "auth", token: "b".repeat(64) }));
  await once(wrong, "close");
  const socket = new WebSocket(setup.wsUrl, { origin });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const authenticated = once(socket, "message");
  socket.send(JSON.stringify({ type: "auth", token: setup.token }));
  assert.equal(JSON.parse(String((await authenticated)[0])).type, "authenticated");
  socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (message.type === "probe")
      socket.send(
        JSON.stringify({
          type: "result",
          requestId: message.requestId,
          data: { tabId: message.tabId, sceneReadable: false },
        })
      );
  });
  const result = await request(port, "/research/probe?tabId=42", {});
  assert.deepEqual(result.data, { tabId: 42, sceneReadable: false });
  const status = await request(port, "/research/status");
  assert.equal(status.clients.length, 1);
  assert.equal(status.token, undefined);
  assert.deepEqual((await request(port, "/rpc", { tool: "list_files" })).data, []);
  socket.close();
  await once(socket, "close");
  await assert.rejects(request(port, "/research/probe", {}), { code: "RESEARCH_CLIENT_REQUIRED" });
});

test("page probe does not pretend DOM access is a scene API and records partial writes", async () => {
  globalThis.location = { origin: "https://www.figma.com", pathname: "/design/test" };
  globalThis.document = { querySelectorAll: () => [] };
  try {
    const result = await pageProbe("smoke");
    assert.equal(result.status, "UNSUPPORTED");
    const frame = {
      id: "1:1",
      resize() {},
      appendChild() {},
      exportAsync() {
        throw new Error("export failed");
      },
    };
    globalThis.figma = {
      currentPage: { children: [] },
      loadFontAsync: async () => {},
      createFrame: () => frame,
      createText: () => ({ id: "1:2" }),
      getNodeByIdAsync: async () => frame,
    };
    const partial = await pageProbe("smoke");
    assert.equal(partial.status, "PARTIAL");
    assert.equal(partial.nodeId, "1:1");
    assert.equal(partial.textId, "1:2");
    assert.equal((await pageProbe("verify", "1:1")).persistedNodeId, "1:1");
  } finally {
    delete globalThis.figma;
    delete globalThis.location;
    delete globalThis.document;
  }
});
