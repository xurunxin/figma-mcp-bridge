import { cp, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";

const source = fileURLToPath(new URL("../skills/figma-bridge/", import.meta.url));
export const skillInfo = {
  name: "figma-bridge",
  description: "通过 CLI 读取、编辑和导出 Figma，无需配置 MCP",
};

export async function showSkill(): Promise<string> {
  return readFile(path.join(source, "SKILL.md"), "utf8");
}

async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new BridgeError("INVALID_SKILL", "Skill 包中不允许符号链接", 2);
    if (entry.isDirectory()) result.push(...(await files(root, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function assertNoLinks(destination: string): Promise<void> {
  let current = path.resolve(destination);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new BridgeError("UNSAFE_PATH", `安装路径含符号链接或 junction：${current}`, 2);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function installSkill(options: {
  target: string;
  agent: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<unknown> {
  const root = path.resolve(options.target);
  const agents = options.agent === "all" ? ["agents", "claude"] : [options.agent];
  const bundle = await files(source);
  const installs = agents.map((agent) => ({
    destination: path.join(
      root,
      agent === "claude" ? ".claude" : ".agents",
      "skills",
      "figma-bridge"
    ),
    files: bundle,
  }));
  for (const install of installs) {
    await assertNoLinks(install.destination);
    for (const relative of bundle) {
      const destination = path.join(install.destination, relative);
      await assertNoLinks(destination);
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing && (!existing.isFile() || !options.force))
        throw new BridgeError(
          "SKILL_CONFLICT",
          `文件已存在：${destination}；覆盖修改需 --force`,
          2
        );
    }
  }
  if (!options.dryRun) {
    for (const install of installs) {
      for (const relative of bundle) {
        const destination = path.join(install.destination, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await assertNoLinks(destination);
        await cp(path.join(source, relative), destination, {
          force: !!options.force,
          errorOnExist: true,
        });
      }
    }
  }
  return { dryRun: !!options.dryRun, installs };
}
