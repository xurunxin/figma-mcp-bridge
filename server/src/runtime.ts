import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const PRODUCT = "figma-mcp-bridge";
export const PROTOCOL_VERSION = 1;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resolvePort(raw = process.env.FIGMA_BRIDGE_PORT): number {
  if (raw === undefined) return 1994;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new BridgeError("INVALID_PORT", "端口必须是 1–65535 的整数", 2);
  return port;
}

export function stateDirectory(): string {
  return path.resolve(
    process.env.FIGMA_BRIDGE_STATE_DIR ??
      // MSIX hosts virtualize newly created AppData files. A packaged agent and
      // an ordinary terminal would see different auth/lock files at the same
      // apparent path. Keep cross-process state outside AppData on Windows.
      (process.platform === "win32"
        ? path.join(os.homedir(), `.${PRODUCT}`)
        : path.join(
            process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "state"),
            PRODUCT
          ))
  );
}

export async function credentials(port: number): Promise<string> {
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `auth-${port}`);
  try {
    const token = randomBytes(32).toString("hex");
    await writeFile(filename, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (let i = 0; i < 20; i++) {
    const token = (await readFile(filename, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
    await sleep(50);
  }
  throw new BridgeError("INVALID_CREDENTIALS", "本机桥接凭据损坏；请检查状态目录", 3);
}

export interface Health {
  status: "ok";
  product: typeof PRODUCT;
  protocolVersion: number;
  version: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  owner: "cli" | "mcp";
}

export function identity(version: string, owner: Health["owner"]): Health {
  return {
    status: "ok",
    product: PRODUCT,
    protocolVersion: PROTOCOL_VERSION,
    version,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    owner,
  };
}

export async function health(port: number): Promise<Health | null> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") return null;
    throw new BridgeError(
      "BRIDGE_UNREACHABLE",
      `端口 ${port} 无法验证：${(error as Error).message}`,
      3
    );
  }
  const value = (await response.json().catch(() => null)) as Health | null;
  if (
    !response.ok ||
    value?.product !== PRODUCT ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !value.instanceId ||
    !Number.isInteger(value.pid) ||
    !["cli", "mcp"].includes(value.owner)
  )
    throw new BridgeError(
      "INCOMPATIBLE_BRIDGE",
      `端口 ${port} 已被旧版本或其他服务占用；请手动处理，未终止任何进程`,
      3
    );
  return value;
}

export async function request<T>(
  port: number,
  endpoint: string,
  body?: unknown,
  timeout = 210_000
): Promise<T> {
  const token = await credentials(port);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const isTimeout = (error as Error).name === "TimeoutError";
    throw new BridgeError(
      isTimeout ? "TIMEOUT" : "CONNECTION_LOST",
      (error as Error).message,
      isTimeout ? 4 : 3
    );
  }
  let result: { error?: string; errorCode?: string; exitCode?: number };
  try {
    result = (await response.json()) as typeof result;
  } catch (error) {
    // A truncated/malformed reply after dispatch cannot prove that a write failed.
    const isTimeout = (error as Error).name === "TimeoutError";
    throw new BridgeError(
      isTimeout ? "TIMEOUT" : "CONNECTION_LOST",
      "桥接响应不完整，无法确认执行结果",
      isTimeout ? 4 : 3
    );
  }
  if (!response.ok || result.error) {
    if (result.errorCode === "UNAUTHORIZED")
      throw new BridgeError(
        "UNAUTHORIZED",
        "本机凭据不匹配；请让 CLI 与桥接使用同一状态目录。升级前的桥接需由原启动端停止后重新启动",
        3,
        {
          port,
          stateDirectory: stateDirectory(),
          hint: "Use the same absolute FIGMA_BRIDGE_STATE_DIR in both processes. Stop a legacy bridge from its original terminal before upgrading. Do not delete or replace credentials of a running bridge.",
        }
      );
    throw new BridgeError(
      result.errorCode ?? "OPERATION_FAILED",
      result.error ?? `HTTP ${response.status}`,
      result.exitCode ?? 5
    );
  }
  return result as T;
}
