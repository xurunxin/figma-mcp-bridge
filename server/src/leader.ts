import http from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { Bridge } from "./bridge.js";
import { validateRpc } from "./schema.js";
import { VERSION } from "./version.js";
import { asBridgeError, BridgeError } from "./errors.js";
import { credentials, identity, type Health } from "./runtime.js";
import type { RPCRequest } from "./types.js";
import { ResearchHub } from "./research.js";

export interface LeaderOptions {
  owner?: Health["owner"];
  idleMs?: number;
  onStop?: () => void;
}

export class Leader {
  private bridge = new Bridge();
  private server: http.Server | null = null;
  private token = "";
  private timer?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private inFlight = 0;
  private stopping = false;
  private research = new ResearchHub();
  readonly info: Health;

  constructor(
    private port: number,
    private options: LeaderOptions = {}
  ) {
    this.info = identity(VERSION, options.owner ?? "mcp");
  }
  getBridge(): Bridge {
    return this.bridge;
  }

  async sendWithParams(
    type: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ) {
    if (this.stopping) throw new BridgeError("STOPPING", "桥接正在退出", 3);
    this.inFlight++;
    this.lastActivity = Date.now();
    try {
      return await this.bridge.sendWithParams(type, nodeIds, params, fileKey);
    } finally {
      this.inFlight--;
      this.lastActivity = Date.now();
    }
  }

  async start(): Promise<void> {
    this.token = await credentials(this.port);
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) =>
        this.send(res, 500, { error: String(error), errorCode: "INTERNAL_ERROR", exitCode: 1 })
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? "", "http://localhost").pathname === "/research/ws") {
        this.research.upgrade(req, socket, head);
        return;
      }
      const origin = req.headers.origin;
      const allowed =
        origin === undefined ||
        origin === "null" ||
        origin === "https://www.figma.com" ||
        origin === "https://figma.com";
      if (
        !this.stopping &&
        allowed &&
        new URL(req.url ?? "", "http://localhost").pathname === "/ws"
      )
        this.bridge.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.bridge.close();
      this.research.close();
      throw error;
    }
    server.on("error", (error) => console.error("Bridge HTTP error:", error.message));
    this.server = server;
    if (this.options.owner === "cli") {
      const idle = this.options.idleMs ?? 600_000;
      this.timer = setInterval(
        () => {
          if (this.inFlight === 0 && Date.now() - this.lastActivity >= idle) this.stop();
        },
        Math.min(1000, idle)
      );
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return (
      !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  private send(res: http.ServerResponse, status: number, data: unknown): void {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url === "/ping" && req.method === "GET") {
      this.send(res, 200, this.info);
      return;
    }
    if (!this.authorized(req)) {
      this.send(res, 401, { error: "本机凭据不匹配", errorCode: "UNAUTHORIZED", exitCode: 3 });
      return;
    }
    if (req.url === "/research/status" && req.method === "GET") {
      this.send(res, 200, this.research.status());
      return;
    }
    if (req.url === "/research/setup" && req.method === "POST") {
      this.lastActivity = Date.now();
      this.send(res, 200, this.research.setup(this.port));
      return;
    }
    if (
      new URL(req.url ?? "", "http://localhost").pathname === "/research/probe" &&
      req.method === "POST"
    ) {
      this.inFlight++;
      try {
        const raw = new URL(req.url ?? "", "http://localhost").searchParams.get("tabId");
        const tabId = raw === null ? undefined : Number(raw);
        if (tabId !== undefined && (!Number.isInteger(tabId) || tabId < 0))
          throw new BridgeError("INVALID_ARGUMENT", "无效 tabId", 2);
        this.send(res, 200, { data: await this.research.probe(tabId) });
      } catch (error) {
        const failure = asBridgeError(error);
        this.send(res, 400, {
          error: failure.message,
          errorCode: failure.code,
          exitCode: failure.exitCode,
        });
      } finally {
        this.inFlight--;
        this.lastActivity = Date.now();
      }
      return;
    }
    if (req.url === "/control/status" && req.method === "GET") {
      this.send(res, 200, {
        ...this.info,
        inFlight: this.inFlight,
        lastActivity: this.lastActivity,
        files: this.bridge.listConnectedFiles(),
      });
      return;
    }
    if (req.url === "/control/stop" && req.method === "POST") {
      if (this.info.owner !== "cli") {
        this.send(res, 409, { error: "此实例由 MCP 管理", errorCode: "NOT_OWNED", exitCode: 3 });
        return;
      }
      if (this.inFlight) {
        this.send(res, 409, { error: "仍有请求执行中", errorCode: "BUSY", exitCode: 3 });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) {
          this.send(res, 400, {
            error: "管理请求过大",
            errorCode: "INVALID_ARGUMENT",
            exitCode: 2,
          });
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body?.instanceId !== this.info.instanceId) {
        this.send(res, 409, {
          error: "桥接实例已改变，请重新查询",
          errorCode: "INSTANCE_CHANGED",
          exitCode: 3,
        });
        return;
      }
      if (this.inFlight) {
        this.send(res, 409, { error: "仍有请求执行中", errorCode: "BUSY", exitCode: 3 });
        return;
      }
      this.stopping = true;
      this.send(res, 200, { stopped: true, instanceId: this.info.instanceId });
      setImmediate(() => this.stop());
      return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") {
      this.send(res, 404, { error: "Not found" });
      return;
    }
    if (this.stopping) {
      this.send(res, 503, { error: "桥接正在退出", errorCode: "STOPPING", exitCode: 3 });
      return;
    }
    this.inFlight++;
    this.lastActivity = Date.now();
    try {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new BridgeError("INVALID_ARGUMENT", "需要 application/json", 2);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024)
          throw new BridgeError("PAYLOAD_TOO_LARGE", "RPC 请求超过 64 MiB", 2);
        chunks.push(chunk);
      }
      let value: RPCRequest;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new BridgeError("INVALID_ARGUMENT", "无效 JSON", 2);
      }
      if (
        !value ||
        typeof value.tool !== "string" ||
        (value.fileKey !== undefined && (typeof value.fileKey !== "string" || !value.fileKey)) ||
        (value.nodeIds !== undefined &&
          (!Array.isArray(value.nodeIds) || value.nodeIds.some((id) => typeof id !== "string"))) ||
        (value.params !== undefined &&
          (!value.params || Array.isArray(value.params) || typeof value.params !== "object"))
      )
        throw new BridgeError("INVALID_ARGUMENT", "无效 RPC 请求", 2);
      if (value.tool === "list_files") {
        this.send(res, 200, { data: this.bridge.listConnectedFiles() });
        return;
      }
      if (value.tool === "save_screenshots")
        throw new BridgeError("CLIENT_SIDE_TOOL", "导出落盘应在调用端执行，请升级客户端", 2);
      const validation = validateRpc(value.tool, value.nodeIds, value.params);
      if (validation.error) throw new BridgeError("INVALID_ARGUMENT", validation.error, 2);
      const response = await this.bridge.sendWithParams(
        value.tool,
        value.nodeIds,
        validation.params ?? value.params,
        value.fileKey
      );
      if (response.error)
        throw new BridgeError(response.errorCode ?? "OPERATION_FAILED", response.error);
      this.send(res, 200, { data: response.data });
    } catch (error) {
      const failure = asBridgeError(error);
      this.send(res, failure.exitCode === 2 ? 400 : 200, {
        error: failure.message,
        errorCode: failure.code,
        exitCode: failure.exitCode,
      });
    } finally {
      this.inFlight--;
      this.lastActivity = Date.now();
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.bridge.close();
    this.research.close();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.options.onStop?.();
  }
}
