import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "../../plugin/node_modules/typescript/lib/typescript.js";

const source = await readFile(
  new URL("../../plugin/src/ui/bridge-client.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function harness() {
  let time = 0,
    id = 0;
  const timers = new Map(),
    sockets = [],
    statuses = [],
    requests = [];
  const schedule = (fn, ms, repeat = false) => {
    timers.set(++id, { fn, at: time + ms, ms: repeat ? ms : 0 });
    return id;
  };
  const context = {
    exports: {},
    setTimeout: schedule,
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: (id) => timers.delete(id),
  };
  vm.runInNewContext(compiled, context);
  const client = context.exports.createBridgeClient({
    url: "ws://localhost/ws?fileKey=test",
    now: () => time,
    onStatus: (value) => statuses.push(value),
    onRequest: (value) => requests.push(value),
    socket: (url) => {
      const socket = {
        url,
        readyState: 0,
        sent: [],
        send(value) {
          this.sent.push(JSON.parse(value));
        },
        close() {
          this.readyState = 3;
        },
        open() {
          this.readyState = 1;
          this.onopen?.();
        },
        message(value) {
          this.onmessage?.({ data: JSON.stringify(value) });
        },
      };
      sockets.push(socket);
      return socket;
    },
  });
  function tick(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      const [key, timer] = next;
      time = timer.at;
      if (timer.ms) timer.at += timer.ms;
      else timers.delete(key);
      timer.fn();
    }
    time = end;
  }
  return {
    client,
    sockets,
    statuses,
    requests,
    tick,
    timers,
    jump: (ms) => {
      time += ms;
    },
  };
}

test("connecting sockets time out and error without close still reconnects with bounded backoff", () => {
  const h = harness();
  h.tick(8000);
  assert.equal(h.sockets[0].readyState, 3);
  h.tick(500);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onerror();
  h.tick(999);
  assert.equal(h.sockets.length, 2);
  h.tick(1);
  assert.equal(h.sockets.length, 3);
  h.client.dispose();
  assert.equal(h.timers.size, 0);
});

test("negotiated heartbeat detects half-open connections; old bridges remain compatible", () => {
  const h = harness();
  h.sockets[0].open();
  h.tick(120000);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sockets[0].sent, [{ type: "bridge-hello" }]);
  h.sockets[0].message({ type: "bridge-ready" });
  h.tick(40000);
  assert.equal(h.sockets[0].sent.at(-1).type, "bridge-ping");
  h.tick(20000);
  assert.equal(h.sockets[0].readyState, 3);
  h.tick(500);
  assert.equal(h.sockets.length, 2);
  h.client.dispose();
});

test("pongs sustain the connection and never enter the canvas request handler", () => {
  const h = harness();
  h.sockets[0].open();
  h.sockets[0].message({ type: "bridge-ready" });
  for (let i = 0; i < 8; i++) {
    h.tick(20000);
    h.sockets[0].message({ type: "bridge-pong" });
  }
  assert.equal(h.sockets.length, 1);
  assert.equal(h.requests.length, 0);
  h.client.dispose();
});

test("sleep recovery ignores old socket callbacks and drops late write responses without replay", () => {
  const h = harness();
  const old = h.sockets[0];
  old.open();
  old.message({ type: "create_frame", requestId: "old-write" });
  old.message({ type: "create_frame", requestId: "old-write" });
  const lateMessage = old.onmessage,
    lateClose = old.onclose;
  h.jump(70000);
  h.client.wake();
  const fresh = h.sockets[1];
  fresh.open();
  lateMessage({ data: JSON.stringify({ type: "create_frame", requestId: "late" }) });
  lateClose();
  h.client.respond({ type: "create_frame", requestId: "old-write", data: {} });
  assert.equal(h.requests.length, 1);
  assert.equal(fresh.sent.length, 1);
  fresh.message({ type: "get_metadata", requestId: "new-read" });
  h.client.respond({ type: "get_metadata", requestId: "new-read", data: {} });
  assert.equal(fresh.sent.length, 2);
  assert.equal(fresh.readyState, 1);
  h.client.dispose();
  h.client.wake();
  h.tick(120000);
  assert.equal(h.sockets.length, 2);
});
