import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";
import { stateDirectory } from "./runtime.js";
import { bridgeStatus, withLock } from "./manager.js";

interface ProcessIdentity {
  pid: number;
  path: string;
  startedAt: string;
  root: boolean;
}
interface AppState {
  path?: string;
  installed?: boolean;
  running?: boolean;
  wasRunning?: boolean;
  processes: ProcessIdentity[];
  owned?: ProcessIdentity[];
  reused?: boolean;
}

export function normalizeFigmaUrl(raw: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new BridgeError("INVALID_URL", "需要完整 Figma HTTPS 链接", 2);
  }
  if (
    value.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(value.hostname) ||
    value.port ||
    value.username ||
    value.password
  )
    throw new BridgeError("INVALID_URL", "只接受 figma.com 的 HTTPS 项目或文件链接", 2);
  return value.href;
}

export function desktopUrl(raw: string): string {
  return normalizeFigmaUrl(raw).replace(/^https:/, "figma:");
}

async function windows<T>(action: string, input: unknown): Promise<T> {
  if (process.platform !== "win32")
    throw new BridgeError("UNSUPPORTED_PLATFORM", "首版应用控制仅支持 Windows", 3);
  const helper = fileURLToPath(new URL("../scripts/windows-app.ps1", import.meta.url));
  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-File", helper, "-Action", action],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) =>
      reject(new BridgeError("POWERSHELL_UNAVAILABLE", error.message, 3))
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new BridgeError("TIMEOUT", "应用控制超时，请检查实际状态", 4));
    }, 45_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout.replace(/^\uFEFF/, ""));
        if (code !== 0 || data.error) {
          const match = String(data.error ?? stderr).match(/^([A-Z_]+):\s*([\s\S]*)/);
          reject(
            new BridgeError(
              match?.[1] ?? "APP_CONTROL_FAILED",
              match?.[2] ?? String(data.error ?? stderr),
              3,
              data.details
            )
          );
        } else resolve(data);
      } catch {
        reject(new BridgeError("APP_CONTROL_FAILED", stderr || "无法读取应用控制结果", 3));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

const ownedFile = () => path.join(stateDirectory(), "app.json");
async function savedApp(): Promise<AppState> {
  try {
    return JSON.parse(await readFile(ownedFile(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { processes: [], owned: [] };
    throw error;
  }
}
export async function appStatus(explicitPath?: string): Promise<AppState> {
  const saved = await savedApp();
  const cached =
    saved.path &&
    (await access(saved.path).then(
      () => saved.path,
      () => undefined
    ));
  const result = await windows<AppState>("inspect", { path: explicitPath ?? cached });
  result.owned = (saved.owned ?? []).filter((old) =>
    result.processes.some(
      (p) => p.pid === old.pid && p.startedAt === old.startedAt && p.path === old.path
    )
  );
  return result;
}
export async function startApp(options: {
  target: string;
  browser?: string;
  url?: string;
  path?: string;
}): Promise<unknown> {
  if (options.target === "browser") {
    if (!options.url) throw new BridgeError("INVALID_ARGUMENT", "浏览器模式必须提供 --url", 2);
    return windows("browser", {
      url: normalizeFigmaUrl(options.url),
      browser: options.browser ?? "default",
    });
  }
  const url = options.url ? desktopUrl(options.url) : undefined;
  return withLock("app", async () => {
    const previous = await savedApp();
    const result = await windows<AppState>("start", { path: options.path, url });
    const oldOwned = (previous.owned ?? []).filter((old) =>
      result.processes.some(
        (p) => p.pid === old.pid && p.startedAt === old.startedAt && p.path === old.path
      )
    );
    result.owned = [...oldOwned, ...(result.owned ?? [])];
    await mkdir(stateDirectory(), { recursive: true });
    const temp = `${ownedFile()}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(result));
    await rename(temp, ownedFile());
    return result;
  });
}
export async function stopApp(
  port: number,
  options: { all?: boolean; force?: boolean; path?: string }
): Promise<unknown> {
  return withLock("app", async () => {
    const bridge = await bridgeStatus(port);
    if (bridge?.inFlight) throw new BridgeError("BUSY", "桥接仍有请求执行中，未关闭 Figma", 3);
    const saved = await savedApp();
    const cached =
      saved.path &&
      (await access(saved.path).then(
        () => saved.path,
        () => undefined
      ));
    return windows("stop", { ...options, path: options.path ?? cached, owned: saved.owned ?? [] });
  });
}
