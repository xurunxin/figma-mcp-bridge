# CLI + Skills 本地交付验收

日期：2026-09-19。环境：Windows、Node v24.20.0、Bun v1.4.0、Figma 桌面版 126.9.10。交付版本为本地 npm 包 `0.2.0`；没有发布 npm、创建 release、提交或推送代码。

## 已完成的实现

- CLI 和 MCP 共用 39 项工具定义、参数规范化和执行层。本地图片/图层输入、截图输出由调用端按 workspace 处理。
- 独立守护进程、并发启动收敛、凭据认证、协议与实例校验、10 分钟空闲回收、忙碌时拒绝停止、旧服务拒绝接管。
- Windows 应用定位、启动/复用、文件链接转换、正常关闭和显式强制关闭；浏览器打开接口和“页面打开不等于插件连接”的状态区分。
- 随包 Skill、项目安装器、参考文档、两个命令入口和插件产物。附带独立默认关闭的 Chrome MV3 研究原型。

## 自动化结果

`bun run test`：**70 / 70 通过，无跳过**。该命令先执行插件 TypeScript 检查和构建，再编译服务端并运行 Node 测试。新增重连状态机、握手超时、心跳协商、休眠恢复、迟到响应隔离、CLI 提交前等待、应用心跳不阻止空闲回收，以及 Windows 状态目录、凭据不匹配诊断和 PowerShell 管道 JSON 编码的测试。

| 范围                         | 证据与边界                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 39 项工具                    | 每项 CLI/MCP 处理器一致性、合法 RPC、别名规范化；使用模拟插件响应，不表示 39 项已逐个真实画布执行                                        |
| HTTP / WebSocket / MCP stdio | 真实本地协议和独立 CLI 子进程测试；包括凭据、目标路由、父命令退出、stdio 兼容                                                            |
| 生命周期                     | 4 路并发冷启动单实例；崩溃和遗留锁恢复；实例变化拒绝停止；请求中拒绝停止；健康检查不延长空闲时间                                         |
| 结果不确定                   | 断线写入、响应截断不重试；HTML 部分导入保留 wrapper ID；截图部分成功保留逐项结果                                                         |
| 文件目标                     | 同名文件、多个连接必须选 key、未知 URL key 拒绝、临时 key 重连、跨 socket 响应隔离                                                       |
| 插件权限                     | 构建后的真实插件代码在模拟沙箱执行：Dev Mode 拒绝文档写入，PageNode 序列化，临时 key 会话稳定性；不是实际 Dev Mode UI 测试               |
| 本地文件                     | 两个 workspace、中文路径、越界及 junction 拒绝、导出不覆盖                                                                               |
| Skill                        | 离线行为、dry-run、冲突保护、force、junction 拒绝；官方 quick_validate.py 通过                                                           |
| Windows helper               | 独立隐藏测试程序模拟 Figma 进程：启动返回不被 stdout 污染、不等待应用退出；创建时间不同不接管；正常关闭受阻返回错误；显式 force 关闭成功 |
| Chrome 研究                  | 通道默认关闭、配对认证、研究连接不进入 files list、只读路由和页面探测失败处理；没有真实 Chrome 扩展加载测试                              |

额外检查：服务端编译、插件构建、Chrome JS 语法检查、修改文件的 Prettier 检查和 `git diff --check` 通过。`npm pack` 清单不含状态凭据、node_modules、测试目录或 `.codegraph`。本地 npm 安装使用 `--ignore-scripts`，验证无需 Bun 的使用路径。

## 真实画布闭环

用户在测试 Draft 中手动导入并运行插件后，从**本地 npm 安装包的 CLI** 操作实际 Figma，未配置 MCP 即完成：

1. `files list` 发现连接，`wait` 用真实元数据响应确认可操作。
2. 创建独立 Frame `CLI + Skills 验收 2026-09-19`，ID **`9:2`**，640 × 360；位置在已有顶层节点边界之外。
3. 创建 Text `9:3`，修改文本为 `CLI + Skills / verified`，将 Frame 圆角设为 16；回读核对。
4. 从中文目录导入 PNG，创建图片节点 `9:4`。
5. 从另一工作目录调用同一桥接，显式指定 workspace 导入 HTML 图层 JSON。最终 wrapper **`10:9`**，2 / 2 图层导入，包含可编辑文本。首次手写测试树的矩形遮挡了文本；仅删除本次测试 wrapper 后使用 Frame 背景填充重新导入，未修改其他节点。
6. 导出 PNG 到中文路径，验证 PNG 文件头、640 × 360 尺寸和实际图像显示；最终文件 7532 字节。
7. 使用包内 MCP stdio 入口读取同一节点，与 CLI 返回结果深度比较一致；MCP 同时列出 39 个工具。

最终导出 SHA-256：`cc15ef4525c22f4a67c02bbc9f775b80092812decb6c44676683c80d49b8c215`。

本机证据位于 `.cache/acceptance-1789828120857/中文目录/`：`evidence.json`、`final-readback.json`、`mcp-cli-parity.json` 和 `exports/验收-最终.png`。这些是本机生成的验收记录，未打入发布包，临时连接 key 不应作为配置保存。创建的验收 Frame 留在画布供复核。

manifest 原先尝试使用 `ws://127.0.0.1:1994`，用户实测导入报 allowedDomains URL 错误；已恢复 `ws://localhost:1994`，重新构建后用户确认导入并运行成功。正式 HTTP 监听仍为 loopback。

最终包的 npm 命令入口已返回版本 `0.2.0`，项目 Skill 安装成功。末尾再次检查时插件已断开，`wait` 正确返回超时、旧连接 key 返回 `FILE_NOT_CONNECTED`；没有重放写入。上述真实画布成功证据属于之前已完成的连接会话，再次使用需运行插件并重新发现 key。

## 实机验收状态与剩余门槛

| 项目                                                   | 当前状态                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 真实 Figma 已有实例启动/复用                           | 通过；`reused: true`、`owned: []`，默认 stop 返回 `APP_NOT_OWNED`，原实例保持运行                              |
| 真实 Figma 冷启动、指定文件链接、正常关闭、强制关闭    | 冷启动及打开文件通过，用户确认窗口可见；正常关闭能关闭窗口但后台进程未退出，明确报错；显式强制关闭通过，见下文 |
| 浏览器打开页面                                         | Chrome DevTools 成功启动独立会话但登录失败；内建浏览器已有登录，成功打开测试文件。CLI 浏览器命令仍无通过证据   |
| Chrome 扩展替代及网页插件运行                          | 网页 Plugins 菜单和管理页实测无本地开发插件；真实 Chrome 扩展和结构化 API 仍 NOT RUN，正式替代 No-Go           |
| 真多文件/同名文件、真实 Dev Mode、所有 39 工具逐项操作 | 有协议/沙箱自动化覆盖，尚未逐项实际 Figma UI 验收                                                              |

## 复验步骤

1. 执行根目录 `bun run build:package`、`bun run test`、在 server 目录 `npm pack`，将 tgz 安装到独立目录。
2. 通过包内 CLI `doctor` 找到插件 manifest；手动导入并在测试文件运行。每次重新获取 `files list` 的 key。
3. 按 Skill 的 edit/files 参考文档依次创建 Frame、Text、修改文本/颜色、导入图片和图层、导出、`get_node` 回读。每次写入后保存节点 ID，不对结果未知的请求自动重试。
4. 在允许关闭的测试应用会话，运行 `app open`、`app status`、`app stop`；遇到正常关闭受阻，确认无未保存工作后才测试 `--force`。已有实例用 `--all` 才纳入关闭范围。
5. Chrome 原型按 `research/README.md` 的单标签、刷新、双标签和重连流程记录版本与证据。基础能力未通过前，不将扩展接入正式工具后端。

## 后续重连与桌面实测（2026-09-19）

用户重新运行新版插件后，在同一 WorkMesh 文件完成只读验收，没有新建或重放画布写入：

- 显式停止/重启 CLI 桥接后，插件自动恢复；相同连接标识的元数据与重启前深度一致。
- 测试环境将空闲时间设为 8000 ms，真实插件连接后等待 10500 ms，桥接自行退出。
- 下一次 `call get_metadata` 自动启动新守护进程，并在提交前等待插件重连；实例 UUID 改变，元数据一致。
- 再等待 45 秒跨过心跳周期，仍能得到相同的元数据。该项不是完整等待 10 分钟的耐久测试。
- 证据和可复现脚本：`.cache/reconnect-acceptance/evidence.json`、`.cache/reconnect-live.mjs`（本机验收材料，不打入 npm 包）。

桌面 Figma 126.9.10：最初进程为零，CLI 冷启动产生了所管理的根进程。发现启动器错误地隐藏了交互应用窗口，已改为 Normal；PowerShell 后台 helper 仍隐藏。原隐藏实例正常关闭受阻，显式 force 成功。

随后用户手动打开应用、文件并运行新版插件。`app stop --all` 关闭了窗口及插件连接，但仍有 6 个后台进程，返回 `APP_CLOSE_BLOCKED`。显式 `app stop --all --force` 成功，`app status` 验证进程数为零。正常关闭不能将“窗口消失”当成“应用进程全部退出”，现已添加 `windowCloseRequested` 与 `remainingPids` 诊断。

修复后的 CLI 启动并打开文件命令被执行工具拒绝，原始原因仅为 `blocked by policy`；具体拒绝来源未提供，先前称为“自动审批”不够准确。经用户要求跳过 RTK 直接执行，同样被拒绝；没有通过其他启动机制绕过。

用户后续提供手动命令的 `UNAUTHORIZED` 错误，证明它停在桥接鉴权阶段，尚未执行到应用启动。新增 UTF-8 控制台解码设置与日志捕获说明（本机 `.cache/desktop-cold-start-check.md`）。

鉴权修复后，用户在同一 Codex 内置终端重新执行 CLI 启动命令，并确认“已显示 Figma 窗口并打开 WorkMesh”。命令日志返回 `reused: false`、`opened: true`，记录所管理的根进程 PID 26708、启动时间 `2026-09-19T15:21:54.1041580Z`；随后工具侧只读 `app status` 核对了同一 PID、可执行路径和启动时间。可见窗口及文件页面由用户确认，进程所有权由实际 CLI 日志与状态核验，不能混淆这两类证据。本机记录为 `.cache/desktop-start-result.log` 和 `.cache/desktop-acceptance/evidence.json`。

冷启动后的 `files: []` 与 `targetReady: false` 正确表示插件尚未运行；应用成功打开不代表插件会自动启动。现有重连可恢复仍在运行的插件，不能重新运行已经被关闭的 Figma 插件。

## Windows 跨执行环境鉴权修复（2026-09-19）

工具进程实际观察到 `%LOCALAPPDATA%/figma-mcp-bridge/auth-1994` 与 Codex 包私有 `LocalCache/Local/figma-mcp-bridge/auth-1994` 的 NTFS 设备和文件 ID 完全一致。这证明该进程的 AppData 访问被重定向。用户在 Codex 内置终端访问同一监听端口时却得到 `UNAUTHORIZED`；不能仅比较路径字符串推断它们共享状态。

Windows 默认状态改为 `%USERPROFILE%/.figma-mcp-bridge`，保留 `FIGMA_BRIDGE_STATE_DIR` 显式覆盖。先用原运行环境停止 CLI 管理的旧桥接，再从新位置启动；没有删除旧凭据、关闭鉴权或自动终止未知监听进程。`UNAUTHORIZED` 现在包含客户端状态目录、端口与恢复说明，不输出凭据。

修复后，工具侧和用户内置终端均成功读取实例 `0622c34d-6739-42f3-b102-63a37a89169e` 的鉴权状态，跨环境调用恢复。新增回归验证 Windows 默认路径不在 AppData，以及不同凭据目录拒绝接管、保留原凭据并提供明确诊断。

Windows 行为依据：[Microsoft — packaged desktop apps 的 AppData 重定向](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)。这项修复解决了真实 `UNAUTHORIZED`；执行工具的 `blocked by policy` 是另一问题，未据此宣称消除。

## Windows 管道 JSON 编码修复

用户的冷启动日志保留了进程信息，但末尾中文 `next` 字段被 PowerShell 管道错误解码，连 JSON 结束引号也已损坏。原日志保留不改，桌面验收脚本只解析完好的结构前缀，并在证据中明确记录这一限制。

CLI 现对 Windows 非交互输出使用标准 JSON Unicode 转义；交互输出和帮助保持原文。使用 PowerShell 7、显式代码页 936、`Tee-Object` 和 `ConvertFrom-Json` 复现：旧版本产生乱码；修复后成功输出及错误输出均可解析，中文、emoji、完整 Skill 内容与直接调用一致，退出码保持不变。该检查只使用离线命令，不启动 Figma 或桥接。

## 全局安装后的 CLI 实机验证

使用 `npm install --global --ignore-scripts --no-audit --no-fund` 安装本地 `0.2.0` tgz。包 SHA-256 为 `1e02d866b98a81e1ccfa4c552b7a5ab2482ca49f4684042bd7a8b2bc86ba08b8`，命令解析至 `C:/nvm4w/nodejs/figma-bridge.ps1`。全局 CLI 的版本、doctor、39 项工具列表正常，安装后的 CLI、状态管理、Windows helper 和插件产物与已验证的构建产物一致。

启动前确认 Figma 进程为零且桥接未运行。直接执行安装后的 `figma-bridge app start --target desktop --url <测试文件>`，没有使用 RTK，仍被执行工具在创建进程前拒绝，原始结果为 `blocked by policy`。全局安装没有消除该拒绝，工具未提供具体规则来源。`figma-bridge bridge start` 则正常创建了桥接。用户随后从内置终端运行同一 CLI 启动命令，并确认已打开应用及运行插件。

之后所有画布命令均通过已安装的 `figma-bridge` shim 执行，在独立验收目录中读取 JSON 参数并保存输出：

- `wait` 验证 WorkMesh 的真实元数据响应，`get_document` 读取画布。
- 创建 Frame `18:2`（名称 `CLI 全局安装验收 2026-09-19`，480 × 200，位于既有验收 Frame 右侧）和 Text `18:3`。
- 圆角修改为 20，文字修改为 `Installed CLI verified` / `Read / write / export`；`get_node` 回读验证节点、中文名称、尺寸、属性和内容。
- `save_screenshots` 导出中文路径 PNG，480 × 200、7570 字节，实际查看图片通过。SHA-256 为 `1df2a0bd33cb9bef0313f2a40cbd01646599080ff9e1a840431b5ec23c07fdd5`。

桥接启动、画布读取、创建、修改、回读及导出均未遭到执行工具拒绝。此次被拒绝的是 Agent 发起 Figma 应用启动的命令；不能将这一结果扩大为所有 CLI 操作受阻，也不能据此断言具体策略来源。Figma 与验收 Frame 保持打开供复核。本机证据、参数、返回结果和验证脚本位于 `.cache/global-cli-acceptance/`，未包含在上述安装包中。

## 2026-09-20 应用入口与运行状态复验

应用入口改为 `app open`，保留 `app start` 兼容别名。用户切换任务为完全访问后，Agent 经全局安装的 CLI 执行 `app open --target desktop --url <测试文件>` 成功，未再收到 `blocked by policy`。返回 `running: true`、`wasRunning: true`、`reused: true`，主进程 PID 13868 和创建时间保持一致，证明复用了已有实例。`app status` 同样返回运行状态和经过身份核对的 `owned`。此次没有插件连接，不将应用打开成功视为画布操作验收。

提交前运行根目录 `bun run test`：插件类型检查及构建、服务端编译成功，70 项测试全部通过，无跳过。Windows 生命周期测试使用独立模拟程序验证未运行、启动、复用、过期身份拒绝关闭及关闭后状态，不关闭真实 Figma。Agent 使用说明约定根据状态决定是否重启，并在关闭成功后重新打开。
