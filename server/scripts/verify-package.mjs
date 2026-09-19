import { access } from "node:fs/promises";
for (const name of [
  "dist/index.js",
  "dist/cli.js",
  "dist/daemon.js",
  "plugin/manifest.json",
  "plugin/dist/code.js",
  "plugin/dist/index.html",
  "skills/figma-bridge/SKILL.md",
  "scripts/windows-app.ps1",
  "docs/cli.md",
  "research/README.md",
  "LICENSE.md",
]) {
  await access(new URL(`../${name}`, import.meta.url)).catch(() => {
    throw new Error(
      `Missing ${name}; run bun run build:package at the repository root before packing.`
    );
  });
}
