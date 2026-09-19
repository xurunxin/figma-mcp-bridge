import { BridgeError } from "./errors.js";
import { request, sleep } from "./runtime.js";
import type { ConnectedFile } from "./types.js";

/** Wait only before dispatch. Never retry an operation whose outcome may be unknown. */
export async function awaitConnection(port: number, fileKey: string | undefined, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  do {
    const { data: files } = await request<{ data: ConnectedFile[] }>(
      port,
      "/rpc",
      { tool: "list_files" },
      Math.max(1, deadline - Date.now())
    );
    if (!fileKey && files.length > 1)
      throw new BridgeError("FILE_REQUIRED", "多个文件已连接，请使用 --file-key", 2);
    const file = fileKey ? files.find((entry) => entry.fileKey === fileKey) : files[0];
    if (file) return file.fileKey;
    if (fileKey && files.length)
      throw new BridgeError(
        "FILE_NOT_CONNECTED",
        "指定连接标识不存在；请用 files list 重新发现目标",
        3
      );
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new BridgeError(
    fileKey ? "FILE_NOT_CONNECTED" : "PLUGIN_NOT_CONNECTED",
    "插件尚未连接；请在目标文件中运行插件，再用 files list 发现连接标识",
    3
  );
}
