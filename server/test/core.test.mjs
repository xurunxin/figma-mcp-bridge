import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolRegistry, executeTool, registerTools } from "../dist/tools.js";
import { validateRpc } from "../dist/schema.js";
import { BridgeError } from "../dist/errors.js";
import { installSkill } from "../dist/skills.js";
import { normalizeFigmaUrl, desktopUrl } from "../dist/app.js";

const nodeId = "12:34";
const samples = {
  list_files: {},
  get_document: {},
  get_selection: {},
  get_node: { nodeId },
  get_styles: {},
  get_metadata: {},
  get_design_context: { depth: 2 },
  get_variable_defs: {},
  get_screenshot: { nodeIds: [nodeId] },
  set_node_visibility: { items: [{ nodeId, visible: true }] },
  set_text_content: { nodeId, characters: "中文 alias" },
  set_text_properties: { nodeId, fontSize: 18 },
  set_node_properties: { nodeId, x: 30 },
  set_solid_fill: { nodeId, fillHex: "#abcdef", fillOpacity: 0.5 },
  set_gradient_fill: {
    nodeId,
    gradientStops: [
      { position: 0, hex: "#000000" },
      { position: 1, hex: "#ffffff" },
    ],
  },
  set_effects: { nodeId, effects: [] },
  set_stroke_properties: { nodeId, strokeWeight: 2 },
  set_auto_layout: { nodeId, layoutMode: "VERTICAL" },
  create_page: { name: "CLI" },
  create_frame: { width: 200 },
  create_text: { characters: "Text" },
  create_shape: { shapeType: "RECTANGLE" },
  create_image: { source: "图片.bin" },
  import_html_layers: { source: "layers.json" },
  duplicate_nodes: { nodeIds: [nodeId] },
  reparent_nodes: { nodeIds: [nodeId], parentId: "1:2" },
  group_nodes: { nodeIds: [nodeId] },
  ungroup_node: { nodeId },
  set_selection: { nodeIds: [] },
  scroll_and_zoom_into_view: { nodeIds: [nodeId] },
  delete_nodes: { nodeIds: [nodeId], confirm: true },
  get_motion_styles: {},
  get_node_motion: { nodeId },
  apply_animation_style: { nodeId, styleId: "preset" },
  remove_animation_style: { nodeId },
  apply_manual_keyframe_track: { nodeId, field: { type: "PROPERTY" }, track: {} },
  remove_manual_keyframe_track: { nodeId, field: { type: "PROPERTY" } },
  set_timeline_duration: { nodeId, timelineId: "timeline", duration: 1 },
  save_screenshots: { items: [{ nodeId, outputPath: "out.png" }] },
};

function fakeBackend() {
  const calls = [];
  return {
    calls,
    listConnectedFiles: async () => [{ fileKey: "test-key", fileName: "test" }],
    async send(type, nodeIds, fileKey) {
      return this.sendWithParams(type, nodeIds, undefined, fileKey);
    },
    async sendWithParams(type, nodeIds, params, fileKey) {
      assert.equal(validateRpc(type, nodeIds, params).error, null, `wire contract: ${type}`);
      calls.push({ type, nodeIds, params, fileKey });
      const data =
        type === "get_screenshot"
          ? {
              exports: [
                {
                  nodeId,
                  nodeName: "test",
                  width: 1,
                  height: 1,
                  format: "PNG",
                  base64: "aGVsbG8=",
                },
              ],
            }
          : { type, nodeIds, params, fileKey };
      return { type, requestId: "test", data };
    },
  };
}

test("all 39 tools share CLI/MCP handlers and valid canonical RPC contracts", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-core-"));
  const roots = [path.join(base, "CLI 中文"), path.join(base, "MCP")];
  for (const root of roots) {
    await mkdir(root);
    await writeFile(path.join(root, "图片.bin"), "image");
    await writeFile(
      path.join(root, "layers.json"),
      JSON.stringify({ type: "FRAME", children: [] })
    );
  }
  const cli = fakeBackend(),
    mcp = fakeBackend();
  const registry = createToolRegistry(cli, roots[0]);
  const callbacks = new Map();
  registerTools(
    {
      tool(name, description, shape, callback) {
        callbacks.set(name, callback);
      },
    },
    mcp,
    0,
    roots[1]
  );
  assert.equal(registry.size, 39);
  assert.deepEqual([...registry.keys()].sort(), Object.keys(samples).sort());
  assert.equal(callbacks.size, 39);
  for (const [name, sample] of Object.entries(samples)) {
    await t.test(name, async () => {
      const args = { ...sample, fileKey: "test-key" };
      const result = await executeTool(registry, name, args);
      const mcpResult = await callbacks.get(name)(args);
      assert.notEqual(mcpResult.isError, true, mcpResult.content[0].text);
      if (name === "save_screenshots") {
        assert.equal(result.succeeded, 1);
        assert.equal(await readFile(path.join(roots[0], "out.png"), "utf8"), "hello");
        assert.equal(await readFile(path.join(roots[1], "out.png"), "utf8"), "hello");
      } else assert.deepEqual(JSON.parse(mcpResult.content[0].text), result);
    });
  }
  assert.deepEqual(cli.calls, mcp.calls);
  assert.equal(cli.calls.find((c) => c.type === "set_text_content").params.text, "中文 alias");
  assert.equal(cli.calls.find((c) => c.type === "set_solid_fill").params.hex, "#abcdef");
  assert.equal(
    cli.calls.find((c) => c.type === "create_image").params.imageBase64,
    Buffer.from("image").toString("base64")
  );
});

test("invalid input does not dispatch; sent writes are never automatically retried", async () => {
  const backend = fakeBackend();
  const registry = createToolRegistry(backend);
  await assert.rejects(executeTool(registry, "get_node", { nodeId: "12-34" }), {
    code: "INVALID_ARGUMENT",
    exitCode: 2,
  });
  await assert.rejects(executeTool(registry, "set_text_content", { nodeId }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(executeTool(registry, "set_node_properties", { nodeId }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(executeTool(registry, "__proto__", {}), { code: "UNKNOWN_TOOL" });
  assert.ok(validateRpc("constructor").error);
  assert.equal(backend.calls.length, 0);
  let calls = 0;
  backend.sendWithParams = async () => {
    calls++;
    throw new BridgeError("CONNECTION_LOST", "disconnected", 3);
  };
  await assert.rejects(executeTool(registry, "create_frame", {}), {
    code: "OUTCOME_UNKNOWN",
    exitCode: 5,
  });
  assert.equal(calls, 1);
  await assert.rejects(executeTool(registry, "get_document", {}), {
    code: "CONNECTION_LOST",
    exitCode: 3,
  });
});

test("workspace containment, junction escape and partial exports", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-paths-"));
  const root = path.join(base, "workspace"),
    outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "image.bin"), "outside");
  await symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const backend = fakeBackend(),
    registry = createToolRegistry(backend, root);
  await assert.rejects(executeTool(registry, "create_image", { source: "escape/image.bin" }));
  await assert.rejects(executeTool(registry, "import_html_layers", { source: "escape/image.bin" }));
  await assert.rejects(
    executeTool(registry, "save_screenshots", {
      items: [
        { nodeId, outputPath: "safe.png" },
        { nodeId, outputPath: "escape/bad.png" },
        { nodeId, outputPath: "../bad.png" },
      ],
    }),
    (error) =>
      error.code === "PARTIAL_COMPLETION" &&
      error.details.succeeded === 1 &&
      error.details.failed === 2
  );
  assert.equal(await readFile(path.join(root, "safe.png"), "utf8"), "hello");
  await assert.rejects(readFile(path.join(outside, "bad.png")));
  await assert.rejects(
    executeTool(registry, "save_screenshots", { items: [{ nodeId, outputPath: "safe.png" }] }),
    { code: "PARTIAL_COMPLETION" }
  );
});

test("skill installation is offline, protects conflicts and rejects junctions", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "figma-skills-"));
  const result = await installSkill({ target: base, agent: "all", dryRun: true });
  assert.equal(result.installs.length, 2);
  await assert.rejects(readFile(path.join(base, ".agents/skills/figma-bridge/SKILL.md")));
  await installSkill({ target: base, agent: "all" });
  const entry = path.join(base, ".agents/skills/figma-bridge/SKILL.md");
  await writeFile(entry, "custom");
  await assert.rejects(installSkill({ target: base, agent: "all" }), { code: "SKILL_CONFLICT" });
  assert.equal(await readFile(entry, "utf8"), "custom");
  await installSkill({ target: base, agent: "all", force: true });
  assert.match(await readFile(entry, "utf8"), /name: figma-bridge/);
  const other = path.join(base, "other");
  await mkdir(other);
  await symlink(
    path.join(base, ".agents"),
    path.join(other, ".agents"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(installSkill({ target: other, agent: "agents", force: true }), {
    code: "UNSAFE_PATH",
  });
});

test("URLs preserve projects and node queries without accepting credentials or foreign hosts", () => {
  const url = "https://www.figma.com/design/key/Test?node-id=1-2";
  assert.equal(normalizeFigmaUrl(url), url);
  assert.equal(desktopUrl(url), "figma://www.figma.com/design/key/Test?node-id=1-2");
  assert.equal(
    normalizeFigmaUrl("https://www.figma.com/files/team/123/project/456"),
    "https://www.figma.com/files/team/123/project/456"
  );
  for (const bad of [
    "http://figma.com",
    "https://figma.com.evil.test",
    "https://user:pass@figma.com",
    "file:///C:/test",
    "https://figma.com:9000",
  ]) {
    assert.throws(() => normalizeFigmaUrl(bad), { code: "INVALID_URL" });
  }
});
