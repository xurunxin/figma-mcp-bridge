export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 5,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return new BridgeError("TIMEOUT", message, 4);
  if (/No plugin connected for fileKey/i.test(message))
    return new BridgeError("FILE_NOT_CONNECTED", message, 3);
  if (/No plugin connected|No files are currently connected|Plugin not connected/i.test(message))
    return new BridgeError("PLUGIN_NOT_CONNECTED", message, 3);
  if (/Multiple files connected/i.test(message))
    return new BridgeError("FILE_REQUIRED", message, 2);
  if (/disconnected|connection (error|closed)|fetch failed|ECONNRESET/i.test(message))
    return new BridgeError("CONNECTION_LOST", message, 3);
  return new BridgeError("OPERATION_FAILED", message);
}
