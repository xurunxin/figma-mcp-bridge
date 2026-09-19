import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeError } from "./errors.js";

// A separate, opt-in evidence channel. Research clients can never become Figma file connections.
export class ResearchHub {
  private token?: string;
  private server = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private clients = new Map<WebSocket, { id: string; tabs: unknown[]; evidence?: unknown }>();
  private pending = new Map<
    string,
    {
      socket: WebSocket;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  setup(port: number): unknown {
    this.token ??= randomBytes(32).toString("hex");
    return {
      experimental: true,
      wsUrl: `ws://127.0.0.1:${port}/research/ws`,
      token: this.token,
      note: "仅在扩展弹窗中粘贴；研究连接不提供正式画布工具，也不会出现在 files list。",
    };
  }
  status(): unknown {
    return { experimental: true, enabled: !!this.token, clients: [...this.clients.values()] };
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.token || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? "")) {
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(req, socket, head, (ws) => {
      const authDeadline = setTimeout(() => ws.terminate(), 3000);
      ws.on("message", (bytes) => {
        try {
          const message = JSON.parse(String(bytes));
          if (!this.clients.has(ws)) {
            const expected = Buffer.from(this.token ?? "");
            const supplied = Buffer.from(typeof message.token === "string" ? message.token : "");
            if (
              message.type !== "auth" ||
              supplied.length !== expected.length ||
              !timingSafeEqual(supplied, expected)
            ) {
              ws.terminate();
              return;
            }
            clearTimeout(authDeadline);
            this.clients.set(ws, { id: randomUUID(), tabs: [] });
            ws.send(JSON.stringify({ type: "authenticated" }));
            return;
          }
          if (message.type === "keepalive") {
            ws.send(JSON.stringify({ type: "keepalive" }));
            return;
          }
          const client = this.clients.get(ws)!;
          if (message.type === "tabs" && Array.isArray(message.tabs))
            client.tabs = message.tabs.slice(0, 50);
          if (message.type === "evidence") client.evidence = message.data;
          const pending = this.pending.get(message.requestId);
          if (message.type === "result" && pending?.socket === ws) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            client.evidence = message.data;
            if (message.error)
              pending.reject(new BridgeError("RESEARCH_FAILED", String(message.error)));
            else pending.resolve(message.data);
          }
        } catch {
          ws.close(1003, "Invalid research message");
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearTimeout(authDeadline);
        this.clients.delete(ws);
        for (const [id, item] of this.pending)
          if (item.socket === ws) {
            clearTimeout(item.timer);
            this.pending.delete(id);
            item.reject(new BridgeError("CONNECTION_LOST", "研究扩展断开", 3));
          }
      });
    });
  }
  async probe(tabId?: number): Promise<unknown> {
    if (this.clients.size !== 1)
      throw new BridgeError("RESEARCH_CLIENT_REQUIRED", "请连接且仅连接一个研究扩展实例", 3);
    const ws = this.clients.keys().next().value!;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError("TIMEOUT", "研究探测超时", 4));
      }, 15_000);
      this.pending.set(requestId, { socket: ws, resolve, reject, timer });
      ws.send(JSON.stringify({ type: "probe", requestId, tabId }));
    });
  }
  close(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new BridgeError("CONNECTION_LOST", "研究通道关闭", 3));
    }
    this.pending.clear();
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.server.close();
    this.token = undefined;
  }
}
