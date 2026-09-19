import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolRegistry, executeTool } from "../dist/tools.js";

test("partial HTML imports retain the created wrapper ID and never replay", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "figma-partial-"));
  await writeFile(
    path.join(workspace, "layers.json"),
    JSON.stringify({ type: "FRAME", width: 100, height: 100 })
  );
  let calls = 0;
  const registry = createToolRegistry(
    {
      async sendWithParams() {
        calls++;
        return { data: { nodeId: "1:2", layerCount: 1, expectedLayerCount: 2 } };
      },
    },
    workspace
  );
  await assert.rejects(
    executeTool(registry, "import_html_layers", { source: "layers.json" }),
    (error) => {
      assert.equal(error.code, "PARTIAL_COMPLETION");
      assert.equal(error.exitCode, 5);
      assert.equal(error.details.nodeId, "1:2");
      return true;
    }
  );
  assert.equal(calls, 1);
});
