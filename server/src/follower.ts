import type { BridgeResponse, ConnectedFile, RPCResponse } from "./types.js";
import { health, request } from "./runtime.js";

export class Follower {
  private port: number;
  constructor(leaderUrl: string) {
    this.port = Number(new URL(leaderUrl).port);
  }
  send(type: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(type, nodeIds, undefined, fileKey);
  }
  async sendWithParams(
    type: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ): Promise<BridgeResponse> {
    const result = await request<RPCResponse>(this.port, "/rpc", {
      tool: type,
      nodeIds,
      params,
      fileKey,
    });
    return { type, requestId: "", data: result.data };
  }
  async listConnectedFiles(): Promise<ConnectedFile[]> {
    const result = await request<RPCResponse>(this.port, "/rpc", { tool: "list_files" }, 5000);
    return result.data as ConnectedFile[];
  }
  async ping(): Promise<boolean> {
    return (await health(this.port)) !== null;
  }
}
