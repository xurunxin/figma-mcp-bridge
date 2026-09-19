import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createToolRegistry } from "../dist/tools.js";

// Execute the shipped plugin bundle against a sandbox fixture; this is not real canvas acceptance.
const code = await readFile(new URL("../../plugin/dist/code.js", import.meta.url), "utf8");
function sandbox(editorType = "figma") {
  const messages = [];
  let nodeReads = 0;
  const figma = {
    editorType,
    root: { name: "SameName", children: [] },
    currentPage: { id: "0:1", name: "Page", type: "PAGE", children: [], selection: [] },
    showUI() {},
    on() {},
    clientStorage: { getAsync: async () => false },
    ui: {
      postMessage(value) {
        messages.push(value);
      },
      show() {},
      resize() {},
    },
    getNodeByIdAsync: async () => {
      nodeReads++;
      throw new Error("Unexpected read");
    },
  };
  Object.defineProperty(figma, "fileKey", {
    get() {
      throw new Error("not a private plugin");
    },
  });
  vm.runInNewContext(code, { figma, __html__: "", console: { warn() {}, log() {}, error() {} } });
  let next = 0;
  return {
    messages,
    ready: () => figma.ui.onmessage({ type: "ui-ready" }),
    get nodeReads() {
      return nodeReads;
    },
    async call(type, params) {
      const requestId = `test-${++next}`;
      await figma.ui.onmessage({ type: "server-request", payload: { type, params, requestId } });
      return messages.find((message) => message.requestId === requestId);
    },
  };
}

test("built plugin refuses document writes in Dev Mode before accessing scene nodes", async () => {
  const context = sandbox("dev");
  const registry = createToolRegistry({});
  for (const tool of registry.values()) {
    // Selection and viewport changes are permitted in Dev Mode; they do not edit the document.
    if (!tool.mutates || ["set_selection", "scroll_and_zoom_into_view"].includes(tool.name))
      continue;
    const result = await context.call(tool.name, {});
    assert.match(result.error, /Dev Mode/, tool.name);
  }
  assert.equal(context.nodeReads, 0);
});

test("built plugin reads PageNode and generates stable per-session fallback keys", async () => {
  const first = sandbox(),
    second = sandbox();
  const result = await first.call("get_document");
  assert.equal(result.data.type, "PAGE");
  assert.equal(result.data.id, "0:1");
  await first.ready();
  const initial = first.messages.find((message) => message.type === "plugin-status").payload
    .fileKey;
  assert.match(initial, /^unsaved-/);
  assert.equal(
    first.messages.filter((message) => message.type === "plugin-status").at(-1).payload.fileKey,
    initial
  );
  assert.notEqual(
    initial,
    second.messages.find((message) => message.type === "plugin-status").payload.fileKey
  );
});
