# Figma Bridge CLI

CLI 和 MCP 使用同一份 39 项工具注册表。CLI 不需要 MCP 配置；Node.js 20+ 即可运行。Windows 桌面管理通过 PowerShell 7，macOS/Linux 当前仅支持桥接和工具命令，不支持应用管理。

## 命令

| 命令                                                                                 | 作用                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `doctor`                                                                             | 只读检查 Node、应用、端口、桥接和插件安装路径                |
| `app open --target desktop [--url URL] [--path Figma.exe]`                           | 启动或复用桌面应用，打开 Figma HTTPS 链接                    |
| `app open --target browser --url URL [--browser default\|chrome\|edge]`              | 打开文件或项目页面，不管理浏览器生命周期                     |
| `app status [--path Figma.exe]`                                                      | 应用进程身份及桥接连接                                       |
| `app stop [--all] [--force] [--path Figma.exe]`                                      | 正常关闭所管理的桌面实例；显式授权时强制退出                 |
| `bridge start\|status\|stop`                                                         | 启动、检查、停止桥接                                         |
| `files list`                                                                         | 列出文件名和当前连接标识                                     |
| `wait [--file-key ID] [--timeout 秒]`                                                | 等待并用元数据响应确认连接，默认 60 秒                       |
| `tools list`                                                                         | 离线列出名称、说明、读写属性、本地文件行为                   |
| `tools describe NAME`                                                                | 离线查询 JSON Schema 和命令示例                              |
| `call NAME --input 文件或- [--file-key ID] [--workspace 目录]`                       | 从 JSON 文件或 stdin 调用工具                                |
| `skills list\|show`                                                                  | 离线查看附带的 Skill                                         |
| `skills install [--target 目录] [--agent agents\|claude\|all] [--dry-run] [--force]` | 安装项目 Skill，默认当前目录的 `.agents/skills/figma-bridge` |
| `research setup\|status\|probe`                                                      | 独立 Chrome 原型通道，详见研究说明                           |

运行 `figma-bridge help` 或各命令的 `--help` 查询中文帮助。`--port` 为全局选项，默认 `1994`。自定义端口时，插件源代码的 WebSocket 地址和 manifest 白名单也需要相应调整并重新构建。

## 连接和进程

`app open` 返回 `phase: opened`、`bridgeReady` 和 `targetReady: false`。`wait` 只有在实际插件返回元数据后才返回 `phase: plugin-connected`。项目页面不是文件，打开 URL 不会自动选择或绑定一个既有连接。

桌面路径按显式路径、`figma://` 协议注册、标准安装目录定位。普通启动只在原先没有 Figma 实例时记录新进程所有权，身份包含 PID、创建时间和路径。默认 `app stop` 不关闭既有实例；`--all` 才包含当前 Windows 会话的已有 Figma 进程。先请求正常关闭并等待 10 秒，只有 `--force` 才允许强制退出，且终止前重新检查身份。已有业务请求时拒绝关闭。强制退出可能中断尚未同步的编辑，仅在明确需要时使用。

桥接只监听 `127.0.0.1`；HTTP RPC 和管理接口必须带本机自动生成的凭据，CLI 自动发现。插件 WebSocket 仍保留现有协议。Windows 状态目录默认为 `%USERPROFILE%/.figma-mcp-bridge`，可用 `FIGMA_BRIDGE_STATE_DIR` 指定统一的绝对路径。Windows 打包应用可能把 AppData 新文件重定向到私有缓存，因此不再默认使用 `%LOCALAPPDATA%/figma-mcp-bridge`，避免 Agent 与外部终端各自读到不同凭据。凭据用于隔离普通网页请求，不是针对同一用户恶意本地程序的安全边界。

升级时，先在原启动环境用旧版 CLI 执行 `bridge stop`，再运行新版。旧状态不会自动删除或迁移。遇到 `UNAUTHORIZED`，检查错误的 `details.stateDirectory`，确保 CLI、MCP 和守护进程使用同一状态目录；不要删除或覆盖仍在运行的服务的凭据。若旧服务由 MCP 管理，需从原 MCP 客户端停止它。端口上已有不同凭据的服务时，新 CLI 继续拒绝接管，不关闭鉴权。

桥接实例带有产品、协议版本、UUID、PID、创建时间和管理者。旧版本或外部服务占用端口时返回 `INCOMPATIBLE_BRIDGE`，不会杀进程或换端口。CLI 启动使用本机锁和健康检查，父命令退出不影响守护进程。`bridge stop` 只停止 CLI 实例，并校验 UUID 和执行中请求。CLI 可以复用新版本 MCP 创建的桥接，但不能停止它；MCP 也可以作为 CLI 桥接的 follower。更新老版本 MCP 后需手动重启其进程。

默认空闲退出为 600000 ms，`FIGMA_BRIDGE_IDLE_MS` 主要供本地测试调整。退出仅关闭桥接，Figma 应用不随之关闭。插件保持运行时，以 0.5–5 秒退避重连；连接握手超过 8 秒会重新连接。新版桥接协商应用心跳，每 20 秒检查，60 秒未收到响应时重连；页面恢复和网络上线也触发检查。旧桥接不支持心跳时保留兼容行为。心跳不刷新业务空闲时间。

`call` 默认在发出操作前等待插件重连最多 10 秒，可用 `--connect-timeout <秒>` 调整，`0` 关闭等待；`list_files` 不等待。多个文件必须显式选择，未知 key 不会回退到其他文件。连接就绪后才发出一次操作，发送之后的失败不会重试。关闭插件窗口或 Figma 会结束插件，WebSocket 重连不能重新启动已结束的插件；普通 Draft 暂无通用官方自动启动接口，研究结论见 `research/README.md`。

## 参数、路径和结果

`--input` 文件路径相对调用命令的当前目录；JSON 内图片/HTML 图层输入及截图输出路径相对 `--workspace`，默认调用者当前目录。它们在调用端处理，守护进程不解释用户本地路径。UTF-8 BOM 和中文路径可用。路径必须落在 workspace 内，包含 junction/symlink 的真实路径也受此约束。

- `create_image`：支持受限本地图片、公开 HTTP(S) URL 或 data URI；图片最多 32 MiB。
- `import_html_layers`：使用 html-to-figma 格式的图层 JSON，不接受原始 HTML 字符串；文件最多 16 MiB。
- `save_screenshots`：导出结果保存到 workspace，禁止覆盖已有文件。部分失败返回成功项和失败项，供调用者回读核对。
- JSON 中 `fileKey` 和 `--file-key` 冲突时，在发送请求前拒绝执行。
- Dev Mode 写入、节点类型、字体和格式限制沿用插件行为。

成功示例：`{"ok":true,"tool":"get_metadata","data":{...}}`。错误示例：`{"ok":false,"error":{"code":"FILE_REQUIRED","message":"..."}}`。

Windows 管道或重定向下，JSON 的非 ASCII 字符使用标准 `\uXXXX` 转义，防止 PowerShell 的旧代码页解码破坏中文、emoji 或 JSON 语法；JSON 解析后内容不变。交互终端和中文帮助保持原文字显示。

| 退出码 | 含义 / 示例                                                                          |
| ------ | ------------------------------------------------------------------------------------ |
| 0      | 成功；`doctor` 是检查报告，需同时查看各检查项                                        |
| 1      | 内部错误 `INTERNAL_ERROR`                                                            |
| 2      | 参数错误 `INVALID_ARGUMENT`、`FILE_KEY_CONFLICT`、`FILE_REQUIRED`                    |
| 3      | 环境/连接未就绪 `PLUGIN_NOT_CONNECTED`、`FILE_NOT_CONNECTED`、`BUSY`、`NOT_OWNED`    |
| 4      | 超时 `TIMEOUT`                                                                       |
| 5      | 失败、部分完成或结果未知 `OPERATION_FAILED`、`PARTIAL_COMPLETION`、`OUTCOME_UNKNOWN` |

写入发出后超时、断线或响应损坏，不能证明操作没有发生。CLI 返回 `OUTCOME_UNKNOWN` 并且不自动重试。先重新发现连接，读取目标父节点或已返回的节点 ID，再决定下一步。部分完成也不应整批重发。

## Skills

```powershell
figma-bridge skills install --target "X:/MyProject" --dry-run
figma-bridge skills install --target "X:/MyProject"
figma-bridge skills install --target "X:/MyProject" --agent claude
```

默认拒绝覆盖已有 Skill；只有显式 `--force` 才覆盖随包同名文件，其他文件保留。Skill 入口说明连接发现、工具查询、执行和回读；读图、编辑、图片/图层输入与导出通过 references 按需读取。

## 本地开发和交付

```powershell
bun install --frozen-lockfile
bun install --cwd server --frozen-lockfile
bun install --cwd plugin --frozen-lockfile
bun run build:package
bun run test
cd server
npm pack --dry-run
npm pack
```

打包先构建插件、再编译服务端、再复制插件和 Skill。npm 包包含两种命令、Skill、Windows helper 和可导入的插件；`npm pack` 在产物缺失时失败。包不自动发布。原 MCP 命令 `figma-mcp-bridge` 仍通过 stdio 工作。

应用入口现使用 `app open`；`app start` 保留为兼容别名，行为相同。Agent 启动桌面应用或浏览器时仍应遵循宿主的审批流程。

桌面模式 `app status` 返回 `app.running`、当前 `processes` 和校验身份后的 `owned`。`app open` 在启动前检测已有进程，返回 `wasRunning`、`reused` 和打开后的 `running`；已运行时复用实例，有 URL 时向其打开链接，不自动重启。进程存在不代表插件就绪，连接需另外使用 `files list` / `wait` 验证。Agent 需要重启时显式执行 `app stop`，确认关闭成功和 `running: false` 后再执行 `app open`；默认关闭范围仍限于 CLI 持有实例。
