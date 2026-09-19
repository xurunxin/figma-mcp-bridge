import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";
import { health, request, sleep, stateDirectory, type Health } from "./runtime.js";
import type { ConnectedFile } from "./types.js";

export interface BridgeStatus extends Health {
  inFlight: number;
  files: ConnectedFile[];
  lastActivity: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${name}.lock`);
  const nonce = randomUUID();
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      const handle = await open(filename, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const raw = await readFile(filename, "utf8");
        const owner = JSON.parse(raw) as { pid: number };
        if (Number.isInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) {
          if ((await readFile(filename, "utf8")) === raw) await unlink(filename);
          continue;
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") continue;
        const info = await stat(filename).catch(() => null);
        if (info && info.size === 0 && Date.now() - info.mtimeMs > 30_000) {
          await unlink(filename).catch(() => {});
          continue;
        }
      }
      if (Date.now() >= deadline)
        throw new BridgeError("LOCK_BUSY", "另一个进程正在管理桥接或应用；请稍后重试", 3);
      await sleep(100);
    }
  }
  try {
    return await action();
  } finally {
    const owner = JSON.parse(await readFile(filename, "utf8").catch(() => "{}"));
    if (owner.nonce === nonce) await unlink(filename);
  }
}

export async function bridgeStatus(port: number): Promise<BridgeStatus | null> {
  if (!(await health(port))) return null;
  return request<BridgeStatus>(port, "/control/status", undefined, 3000);
}

export async function ensureBridge(port: number): Promise<BridgeStatus> {
  const current = await bridgeStatus(port);
  if (current) return current;
  return withLock(`bridge-${port}`, async () => {
    const existing = await bridgeStatus(port);
    if (existing) return existing;
    const logPath = path.join(stateDirectory(), `daemon-${port}.log`);
    const logInfo = await stat(logPath).catch(() => null);
    const log = await open(logPath, logInfo && logInfo.size > 1024 * 1024 ? "w" : "a", 0o600);
    let launchError: Error | undefined;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./daemon.js", import.meta.url))],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, FIGMA_BRIDGE_PORT: String(port) },
      }
    );
    child.once("error", (error) => {
      launchError = error;
    });
    child.unref();
    await log.close();
    for (let i = 0; i < 100; i++) {
      if (launchError) throw new BridgeError("DAEMON_START_FAILED", launchError.message, 3);
      const ready = await bridgeStatus(port);
      if (ready) return ready;
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    throw new BridgeError("DAEMON_START_FAILED", `桥接启动失败；诊断日志：${logPath}`, 3);
  });
}

export async function stopBridge(port: number): Promise<unknown> {
  return withLock(`bridge-${port}`, async () => {
    const before = await bridgeStatus(port);
    if (!before) return { stopped: true, alreadyStopped: true };
    if (before.owner !== "cli") throw new BridgeError("NOT_OWNED", "此桥接由 MCP 管理，未关闭", 3);
    const result = await request(port, "/control/stop", { instanceId: before.instanceId }, 3000);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const next = await health(port);
      if (!next || next.instanceId !== before.instanceId) return result;
    }
    throw new BridgeError("TIMEOUT", "桥接退出尚未完成", 4);
  });
}
