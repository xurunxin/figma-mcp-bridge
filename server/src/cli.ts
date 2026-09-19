#!/usr/bin/env node
import { Command, CommanderError, Help, Option } from "commander";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createToolRegistry, executeTool } from "./tools.js";
import { Follower } from "./follower.js";
import { BridgeError } from "./errors.js";
import { resolvePort, sleep, stateDirectory, request } from "./runtime.js";
import { bridgeStatus, ensureBridge, stopBridge } from "./manager.js";
import { appStatus, normalizeFigmaUrl, startApp, stopApp } from "./app.js";
import { installSkill, showSkill, skillInfo } from "./skills.js";
import { VERSION } from "./version.js";
import { awaitConnection } from "./connection.js";

const program = new Command();
program
  .name("figma-bridge")
  .description("按需操作 Figma，无需配置 MCP。结果为 JSON，日志写入 stderr。")
  .version(VERSION, "-V, --version", "显示版本")
  .helpOption("-h, --help", "显示帮助")
  .addHelpCommand("help [命令]", "显示指定命令的帮助")
  .option("--port <端口>", "桥接端口，默认 FIGMA_BRIDGE_PORT 或 1994")
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .configureHelp({
    formatHelp: (command, helper) =>
      new Help()
        .formatHelp(command, helper)
        .replace("Usage:", "用法：")
        .replace("Arguments:", "参数：")
        .replace("Options:", "选项：")
        .replace("Commands:", "命令："),
  })
  .addHelpText(
    "after",
    "\n退出码：0 成功；1 内部错误；2 参数错误；3 未就绪；4 超时；5 失败/部分完成。\n环境：FIGMA_BRIDGE_PORT、FIGMA_BRIDGE_STATE_DIR、FIGMA_BRIDGE_IDLE_MS（默认 600000）。\n自定义端口需要同步插件的 WebSocket 地址和 manifest 域名白名单。"
  );

const port = () => resolvePort(program.opts().port);
const backend = () => new Follower(`http://127.0.0.1:${port()}`);
function jsonOutput(value: unknown): void {
  const json = JSON.stringify(value);
  // PowerShell may decode native pipes with a legacy code page even in version 7.
  // ASCII JSON escapes preserve all Unicode, including surrogate pairs, there.
  console.log(
    process.platform === "win32" && !process.stdout.isTTY
      ? json.replace(
          /[\u007f-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
        )
      : json
  );
}
const output = (data: unknown, extra = {}) => jsonOutput({ ok: true, ...extra, data });
const registry = (workspace = process.cwd()) => createToolRegistry(backend(), workspace);

program
  .command("doctor")
  .description("检查本机环境与连接，不启动桥接")
  .action(async () => {
    const checks: Record<string, unknown> = {
      node: process.version,
      platform: process.platform,
      port: port(),
      stateDirectory: stateDirectory(),
      pluginManifest: fileURLToPath(new URL("../plugin/manifest.json", import.meta.url)),
    };
    for (const [name, inspect] of [
      ["app", appStatus],
      ["bridge", () => bridgeStatus(port())],
    ] as const) {
      try {
        checks[name] = await inspect();
      } catch (error) {
        checks[name] = { error: (error as Error).message, code: (error as BridgeError).code };
      }
    }
    output(checks);
  });

const bridge = program.command("bridge").description("本地桥接生命周期");
bridge
  .command("start")
  .description("启动或复用桥接，空闲 10 分钟后退出")
  .action(async () => output(await ensureBridge(port())));
bridge
  .command("status")
  .description("查询桥接，不自动启动")
  .action(async () => output(await bridgeStatus(port())));
bridge
  .command("stop")
  .description("停止 CLI 管理的空闲桥接，不关闭 Figma")
  .action(async () => output(await stopBridge(port())));

const app = program.command("app").description("Windows Figma 桌面应用和浏览器入口");
app
  .command("open")
  .alias("start")
  .description("启动应用或打开链接；插件首次导入和运行需手动完成")
  .addOption(
    new Option("--target <目标>", "打开位置").choices(["desktop", "browser"]).default("desktop")
  )
  .addOption(
    new Option("--browser <浏览器>", "浏览器模式使用的程序")
      .choices(["default", "chrome", "edge"])
      .default("default")
  )
  .option("--url <URL>", "Figma HTTPS 文件或项目页面链接")
  .option("--path <路径>", "Figma.exe 的完整路径")
  .action(async (options) => {
    if (options.url) normalizeFigmaUrl(options.url);
    if (options.target === "browser" && !options.url)
      throw new BridgeError("INVALID_ARGUMENT", "浏览器模式必须提供 --url", 2);
    const ready = await ensureBridge(port());
    output({
      app: await startApp(options),
      phase: "opened",
      bridgeReady: true,
      targetReady: false,
      existingConnections: ready.files,
      next: "手动运行目标文件中的插件，然后执行 files list 和 wait --file-key <连接标识>。打开链接不会自动绑定文件。",
    });
  });
app
  .command("status")
  .description("查询应用与桥接连接状态")
  .option("--path <路径>", "Figma.exe 路径")
  .action(async (options) =>
    output({ app: await appStatus(options.path), bridge: await bridgeStatus(port()) })
  );
app
  .command("stop")
  .description("关闭 CLI 启动的桌面实例，不关闭浏览器")
  .option("--all", "显式包含当前用户会话中已有的 Figma 实例")
  .option("--force", "正常关闭失败后强制终止已验证的 Figma 实例")
  .option("--path <路径>", "Figma.exe 路径")
  .action(async (options) => output(await stopApp(port(), options)));

program
  .command("files")
  .description("发现运行中的插件连接")
  .command("list")
  .description("列出 fileKey 和文件名；fileKey 是连接标识，不保证等于 URL key")
  .action(async () => {
    await ensureBridge(port());
    output(await backend().listConnectedFiles());
  });

program
  .command("wait")
  .description("等待插件连接并读取元数据；不根据 URL 或文件名猜测目标")
  .option("--file-key <ID>", "files list 返回的连接标识")
  .option("--timeout <秒>", "等待时间，默认 60 秒", "60")
  .action(async (options) => {
    const seconds = Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
      throw new BridgeError("INVALID_ARGUMENT", "--timeout 必须在 0–3600 秒之间", 2);
    await ensureBridge(port());
    const deadline = Date.now() + seconds * 1000;
    do {
      const remaining = () => Math.max(1, Math.ceil(deadline - Date.now()));
      const listed = await request<{ data: { fileKey: string; fileName: string }[] }>(
        port(),
        "/rpc",
        { tool: "list_files" },
        remaining()
      );
      const files = listed.data;
      if (!options.fileKey && files.length > 1)
        throw new BridgeError("FILE_REQUIRED", "多个文件已连接，请使用 --file-key", 2);
      const file = options.fileKey ? files.find((f) => f.fileKey === options.fileKey) : files[0];
      if (file) {
        const response = await request<{ data: unknown }>(
          port(),
          "/rpc",
          { tool: "get_metadata", fileKey: file.fileKey },
          remaining()
        );
        output({ phase: "plugin-connected", file, metadata: response.data });
        return;
      }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new BridgeError("TIMEOUT", "等待插件连接超时；请在目标文件中运行插件并检查端口", 4);
  });

const tools = program.command("tools").description("离线发现全部工具");
tools
  .command("list")
  .description("列出工具名称、用途及读写属性")
  .action(() =>
    output(
      [...registry().values()].map(({ name, description, mutates, localFiles }) => ({
        name,
        description,
        mutates,
        localFiles,
      }))
    )
  );
tools
  .command("describe <名称>")
  .description("显示 JSON Schema 与调用示例")
  .action((name: string) => {
    const tool = registry().get(name);
    if (!tool) throw new BridgeError("UNKNOWN_TOOL", `未知工具：${name}`, 2);
    output({
      name,
      description: tool.description,
      mutates: tool.mutates,
      localFiles: tool.localFiles,
      inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: "none" }),
      example: `figma-bridge call ${name} --input args.json --file-key <files list 返回值>`,
    });
  });

program
  .command("call <名称>")
  .description("执行工具；JSON 参数从文件或标准输入读取，不自动重试写操作")
  .requiredOption("--input <文件或->", "UTF-8 JSON 参数文件，- 表示标准输入")
  .option("--file-key <ID>", "桥接连接标识；与 JSON 中的 fileKey 冲突时拒绝")
  .option("--workspace <目录>", "本地输入与导出的根目录，默认调用者当前目录")
  .option("--connect-timeout <秒>", "发出操作前等待插件重连，默认 10 秒；0 表示不等待", "10")
  .action(async (name: string, options) => {
    const seconds = Number(options.connectTimeout);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600)
      throw new BridgeError("INVALID_ARGUMENT", "--connect-timeout 必须在 0–3600 秒之间", 2);
    let workspace: string;
    try {
      workspace = await realpath(path.resolve(options.workspace ?? process.cwd()));
      if (!(await stat(workspace)).isDirectory()) throw new Error("必须是目录");
    } catch (error) {
      throw new BridgeError("INVALID_ARGUMENT", `工作目录不可用：${(error as Error).message}`, 2);
    }
    let source: string;
    if (options.input === "-") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 64 * 1024 * 1024)
          throw new BridgeError("INVALID_ARGUMENT", "输入 JSON 超过 64 MiB", 2);
        chunks.push(bytes);
      }
      source = Buffer.concat(chunks).toString("utf8");
    } else {
      try {
        const filename = path.resolve(options.input);
        if ((await stat(filename)).size > 64 * 1024 * 1024)
          throw new Error("输入 JSON 超过 64 MiB");
        source = await readFile(filename, "utf8");
      } catch (error) {
        throw new BridgeError("INVALID_ARGUMENT", `输入文件不可读：${(error as Error).message}`, 2);
      }
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(source.replace(/^\uFEFF/, ""));
    } catch {
      throw new BridgeError("INVALID_ARGUMENT", "输入不是有效 JSON", 2);
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new BridgeError("INVALID_ARGUMENT", "参数必须是 JSON 对象", 2);
    if (options.fileKey) {
      if (args.fileKey !== undefined && args.fileKey !== options.fileKey)
        throw new BridgeError("FILE_KEY_CONFLICT", "JSON 和 --file-key 指向不同文件", 2);
      args.fileKey = options.fileKey;
    }
    const entries = registry(workspace);
    const tool = entries.get(name);
    if (!tool) throw new BridgeError("UNKNOWN_TOOL", `未知工具：${name}`, 2);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new BridgeError("INVALID_ARGUMENT", parsed.error.message, 2);
    await ensureBridge(port());
    if (name !== "list_files" && seconds > 0)
      args.fileKey = await awaitConnection(port(), args.fileKey as string | undefined, seconds);
    output(await executeTool(entries, name, args), { tool: name });
  });

const skills = program.command("skills").description("查看和安装随包提供的 Skill，不启动桥接");
skills
  .command("list")
  .description("列出可用 Skill")
  .action(() => output([skillInfo]));
skills
  .command("show")
  .description("读取 Skill 入口")
  .action(async () => output({ ...skillInfo, content: await showSkill() }));
skills
  .command("install")
  .description("安装到项目；默认 .agents/skills/figma-bridge")
  .option("--target <目录>", "目标项目目录", process.cwd())
  .addOption(
    new Option("--agent <类型>", "安装位置").choices(["agents", "claude", "all"]).default("agents")
  )
  .option("--dry-run", "只显示目标，不写入")
  .option("--force", "覆盖 Skill 包内同名文件，保留其他文件")
  .action(async (options) => output(await installSkill(options)));

const research = program.command("research").description("实验性 Chrome 扩展能力研究，默认不启用");
research
  .command("setup")
  .description("为本次桥接启用研究通道并显示扩展配对信息")
  .action(async () => {
    await ensureBridge(port());
    output(await request(port(), "/research/setup", {}));
  });
research
  .command("status")
  .description("读取研究证据，不启用通道")
  .action(async () =>
    output(
      (await bridgeStatus(port()))
        ? await request(port(), "/research/status")
        : { enabled: false, clients: [] }
    )
  );
research
  .command("probe")
  .description("只读探测扩展选中的 Figma 标签；不运行画布写入")
  .option("--tab <ID>", "已配对扩展选中的标签 ID")
  .action(async (options) => {
    const tab = options.tab === undefined ? undefined : Number(options.tab);
    if (tab !== undefined && (!Number.isInteger(tab) || tab < 0))
      throw new BridgeError("INVALID_ARGUMENT", "无效 tab ID", 2);
    if (!(await bridgeStatus(port())))
      throw new BridgeError("BRIDGE_NOT_RUNNING", "先执行 research setup", 3);
    output(
      await request(
        port(),
        `/research/probe${tab === undefined ? "" : `?tabId=${tab}`}`,
        {},
        20_000
      )
    );
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    const failure =
      error instanceof BridgeError
        ? error
        : error instanceof CommanderError
          ? new BridgeError("INVALID_ARGUMENT", error.message, 2)
          : new BridgeError("INTERNAL_ERROR", (error as Error).message, 1);
    jsonOutput({
      ok: false,
      error: { code: failure.code, message: failure.message, details: failure.details },
    });
    process.exitCode = failure.exitCode;
  }
}
void main();
