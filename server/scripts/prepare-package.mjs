import { cp, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const server = new URL("../", import.meta.url);
const plugin = new URL("../../plugin/", import.meta.url);
for (const name of ["dist/code.js", "dist/index.html", "manifest.json"]) {
  await readFile(new URL(name, plugin));
}
await mkdir(new URL("plugin/", server), { recursive: true });
await cp(fileURLToPath(new URL("dist/", plugin)), fileURLToPath(new URL("plugin/dist/", server)), {
  recursive: true,
});
await cp(
  fileURLToPath(new URL("manifest.json", plugin)),
  fileURLToPath(new URL("plugin/manifest.json", server))
);
await cp(
  fileURLToPath(new URL("../../README.md", import.meta.url)),
  fileURLToPath(new URL("README.md", server))
);
for (const name of ["docs", "research", "LICENSE.md"]) {
  await cp(
    fileURLToPath(new URL(`../../${name}`, import.meta.url)),
    fileURLToPath(new URL(name, server)),
    { recursive: true }
  );
}
console.log("Prepared CLI, MCP, skills and Figma plugin package");
