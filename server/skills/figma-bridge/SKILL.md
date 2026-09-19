---
name: figma-bridge
description: 使用 figma-bridge CLI 读取、创建、编辑和导出已打开的 Figma 文件，无需配置 MCP。适用于 Figma 画布和本地图片或 HTML 图层导入；不用于仅打开网页后推断设计内容。
---

# Figma Bridge

通过已安装的 `figma-bridge` 命令操作文件。先运行 `figma-bridge --help` 或 `figma-bridge doctor` 获取本机情况。命令结果为 JSON，诊断日志写入 stderr。

## 建立连接

1. 需要打开目标时，使用 `app open --url <Figma HTTPS 链接> --target desktop`；浏览器使用 `--target browser --browser chrome`，也支持 `default` 和 `edge`。
2. 首次使用需要用户导入发行包内的 Figma 插件，并在目标文件中运行。CLI 不自动点击菜单。网页端需要可在网页运行的插件；本地 manifest 导入依赖桌面版。
3. 执行 `files list`，再用返回的 `fileKey` 执行 `wait --file-key <ID>`。项目页面不是画布连接，打开 URL 不会自动选择文件。多文件或同名文件必须核对目标。

`fileKey` 是插件连接标识，可能是 `unsaved-*`，不能从 URL 推导。插件重启后重新发现连接。

## 选择与执行工具

- `tools list` 离线列出全部能力；`tools describe <名称>` 显示输入 JSON Schema。按任务查询需要的工具，不一次加载所有描述。
- 将 JSON 参数写入 UTF-8 文件，然后执行 `call <名称> --input args.json --file-key <ID>`。`--input -` 接受标准输入，避免在 shell 内拼接复杂 JSON。
- 本地图片、HTML 图层源文件及截图输出以调用者当前目录为根；使用 `--workspace <目录>` 明确切换。`--input` 参数文件本身相对于命令调用目录。
- 创建、编辑后回读返回的节点 ID，必要时导出验证。Dev Mode 不允许画布写入。删除需要工具规定的 `confirm: true`，不扩大用户指定的删除范围。
- 收到 `OUTCOME_UNKNOWN` 时先重新连接并回读；不要自动重试写操作。`PARTIAL_COMPLETION` 的 details 包含逐项结果，只处理失败项。

根据任务按需读取：

- [读取与定位](references/read.md)：节点、选择、设计上下文和变量。
- [创建与编辑](references/edit.md)：Frame、文本、样式、自动布局和节点组织。
- [导入与导出](references/files.md)：图片、HTML 图层、截图与路径规则。

## 生命周期

桌面操作前可执行 `app status`：`app.running` 表示当前是否检测到 Figma 进程，`app.owned` 是经过 PID、创建时间和路径核对的 CLI 持有实例。`app open` 自身也会先检测：`wasRunning: true` / `reused: true` 表示复用已有实例，`wasRunning: false` 表示此次启动；`running` 表示打开后的进程状态。进程存在不代表插件已连接或应用响应正常。

Agent 根据状态选择：未运行时执行 `app open`；已运行时通常直接复用并检查 `files list`。没有插件连接时先在目标文件运行插件，不据此重启应用。用户要求重启，或诊断确认必须重启且任务已授权时，先 `app stop`，确认成功并用 `app status` 核对 `running: false`，再 `app open`。关闭失败时先处理错误，不继续当作重启成功；非 CLI 持有实例及强制关闭遵循下面的范围限制。

业务命令自动启动本机桥接，无需编辑 MCP 配置。空闲 10 分钟后桥接退出，Figma 保持打开。`bridge stop` 仅停止 CLI 管理的桥接；正在执行请求时返回忙碌。

插件窗口仍运行时会自动重连。`call` 默认在提交操作前等待连接 10 秒（`--connect-timeout` 可调整），不重试已提交的操作。插件被关闭或 Figma 退出后，需在目标文件重新运行插件；不能将连接重试理解为插件自动启动。

`app stop` 默认仅关闭 CLI 启动的桌面实例。用户要求关闭已有 Figma 时使用 `--all`；正常关闭受阻后，仅在用户要求强制退出时使用 `--force`。浏览器标签与进程不由此命令关闭。

退出码：0 成功，1 内部错误，2 参数错误，3 未就绪，4 超时，5 操作失败或部分完成。以 JSON 的 `error.code` 判定后续动作。端口不同必须同步插件地址和 manifest，不能仅修改 CLI 端口。
