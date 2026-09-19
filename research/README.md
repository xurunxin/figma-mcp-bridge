# Chrome 扩展完全替代研究

结论：**正式后端替换 No-Go；独立实验原型可继续验证。** 本轮交付一个默认关闭的 Manifest V3 原型及可复现探测入口。尚未取得真实 Figma 网页中等价结构化读写的证据，不能将连接成功、DOM 可访问或单个矩形创建等同于 39 项工具可用。

## 依据与三条路线

| 路线                        | 原型覆盖                                                           | 尚需证明                                               | 判断                                                           |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| DOM / 键鼠                  | 收集 canvas/iframe 可见结构                                        | 可靠读取节点 ID/树/属性，选择、创建和持久化            | DOM 可访问不能证明画布语义可访问；暂不实现坐标点击作为正式后端 |
| MAIN world / CDP / 内部接口 | 只读探测页面 `figma` 对象和方法；CDP 固定表达式探测                | 等价结构化 API、稳定修改、导出、刷新后持久化及版本保障 | 实验性；不接入未验证的私有内部接口                             |
| 扩展 + 网页 Figma 插件      | 独立标签选择、WebSocket 配对、重连和证据通道；正式插件协议继续保留 | 合适的插件分发、网页端运行、标签与插件会话关联         | 可研究浏览器替代桌面；仍依赖 Figma 插件，不是完全替代          |

Figma 插件在沙箱内执行，UI iframe 与画布 API 分离：[插件执行模型](https://developers.figma.com/docs/plugins/how-plugins-run/)。Chrome 内容脚本默认隔离执行；MAIN world 允许页面上下文访问，但不授予插件沙箱能力：[内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。这是“无法保证替代”的架构判断，不是本机运行结论。

[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) 支持页面调试控制，[扩展 Service Worker WebSocket](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) 在 Chrome 116+ 支持通过收发消息延长生命周期；两者解决控制/通信，不直接提供 Figma Plugin API。原型每 20 秒发送心跳，不先引入 [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 安装步骤。

本地开发插件需通过桌面版导入；网页模式需要合适的插件分发方式：[Figma quickstart](https://developers.figma.com/docs/plugins/plugin-quickstart-guide/)。真实 `figma.fileKey` 也有使用条件，正式 CLI 始终发现实际连接标识：[fileKey 定义](https://developers.figma.com/docs/plugins/api/figma/)。

## 运行原型

1. 构建 CLI，执行 `figma-bridge research setup`。它显式启用本次桥接内的研究通道，返回 loopback WebSocket 地址和临时配对 token。不要把 token 放入报告或提交到仓库。
2. 在 Chrome 116+ 的扩展管理页启用开发者模式，加载本目录 `chrome-extension`。这不属于正式安装流程，不会自动安装或发布。
3. 打开一个可编辑的测试 Figma 文件，在扩展弹窗选择**具体标签**，粘贴地址和 token 后连接。研究连接不会进入 `files list`。
4. 先执行弹窗只读探测和 CDP 只读探测；也可执行 `figma-bridge research probe --tab <标签ID>`。CLI 只能触发只读探测。
5. 仅在测试 Draft 中，勾选允许写入并运行烟测。只有探测到所需 scene API 才尝试创建独立 Frame/Text、修改填充、导出 PNG、回读文本；能力缺失返回 `UNSUPPORTED`，不会退化为点击画布。中途失败返回 `PARTIAL` 和已创建 ID，禁止盲目重试。
6. 手动刷新**同一标签同一文件**，再次验证上次节点。弹窗保存的标签和文件路径必须匹配，否则拒绝验证。保存 JSON 证据，记录 Chrome、Figma 页面/桌面版本、日期和操作结果。
7. 用两个同名文件标签重复第 3–6 步，证明没有跨文件路由。断开/恢复桥接，观察重连后标签仍正确。停止桥接会使 token 失效，重新执行 setup 并配对。

扩展权限包括 scripting、activeTab、storage、debugger 和 Figma host。CDP 仅运行固定只读表达式并 detach；没有任意代码 RPC。配对信息放在 `chrome.storage.session`，浏览器会话结束后清除。连接只接受本机研究路径，扩展端收到的 CLI 消息只运行只读操作。

## 证据与完成门槛

2026-09-19：本机 Figma 安装版本 126.9.10；Node v24.20.0。首次验收的自动化工具初始化失败，后续新增 Chrome DevTools MCP 已能启动 Chrome，但独立 profile 的 Google 登录失败。随后使用 Codex 内建浏览器的已有登录状态成功打开测试文件，观察到此前 CLI 创建的验收 Frame。内建浏览器不等于 Chrome 扩展运行环境；真实 Chrome 扩展加载与页面上下文探测仍未完成。

| 验证项                                            | 当前证据                                 | 状态                         |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| MV3 文件、JS 语法、限定权限和入口                 | 源码检查和 Node 语法检查                 | 静态验证                     |
| 通道默认关闭、配对认证、只读请求、与正式文件隔离  | Node 自动化测试，真实本地 HTTP/WebSocket | 本地通过，不代表 Chrome 验证 |
| scene API 不存在时拒绝写入                        | pageProbe 单测，模拟页面对象             | 本地通过                     |
| 部分写入返回已有节点 ID                           | pageProbe 单测，模拟导出失败             | 本地通过                     |
| 读取选择/节点树；Frame/Text 创建；属性修改；导出  | 需要真实 Figma 网页和扩展                | NOT RUN                      |
| 刷新持久化、多标签隔离、Service Worker 休眠和恢复 | 需要真实 Chrome                          | NOT RUN                      |
| 全部 39 工具行为等价                              | 基础能力未实测，不能宣称覆盖             | NOT RUN                      |

后续 Go 条件：基础闭环在实际版本上通过，记录可重放的结构化结果、节点 ID、导出和刷新证据，再逐项评估正式注册表的 39 个工具；需要稳定、可维护的 API 来源。仅有私有实现可用时仍标记实验性。任何关键读写不可靠时保留正式 Figma 插件后端。

原型不包含扩展商店/Figma Community 发布、账户登录、私有接口逆向或自动操作用户现有画布。

## 插件随应用启动研究（2026-09-19 补充）

结论：**普通 Draft 中的本地开发插件，没有找到受支持的通用自动启动接口。** `app start` 只打开应用/文件；插件仍需在该文件中运行。保持插件运行期间可自动恢复 WebSocket，关闭插件或应用之后不能靠重连复活插件。

| 途径                         | 当前证据                                                                        | 对本项目的判断                                              |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Plugin API 启动事件          | 官方 `run` 事件在插件已被启动后触发                                             | 不是应用/文件启动钩子                                       |
| Enterprise Dev Mode auto-run | 企业组织管理员可设置；排除 Draft；Dev Mode 不允许画布写入                       | 不适用于当前 Draft 编辑工作流                               |
| `setRelaunchData`            | 在属性面板提供用户点击的重启按钮                                                | 可减少查找步骤，仍需操作；未写入本项目文件                  |
| 快捷键/菜单自动化            | 内建浏览器中 “Run last plugin” 禁用；插件管理显示 “No plugins or widgets found” | 本地桌面开发插件未出现在网页；不能凭快捷键保证运行正确插件  |
| Chrome 扩展 + 网页插件       | 需要先解决网页可运行的插件分发                                                  | 可以独立研究显式 opt-in 的菜单启动，不作为正式 CLI 默认路径 |

官方依据：[Plugin API 概览](https://developers.figma.com/docs/plugins/)、[run 事件](https://developers.figma.com/docs/plugins/api/properties/figma-on/)、[Relaunch API](https://developers.figma.com/docs/plugins/api/properties/nodes-setrelaunchdata/)、[企业 Dev Mode 设置](https://help.figma.com/hc/en-us/articles/22927410880535-Manage-Dev-Mode-settings-for-an-organization)、[Dev Mode 写入限制](https://developers.figma.com/docs/plugins/working-in-dev-mode/)。

内建浏览器验收经过：最近文件 → 测试文件 → Main menu → Plugins → Manage plugins。页面和图层可见，但无可运行插件。只验证了 UI 入口与已有画布内容，未用浏览器读取隐藏的应用状态，也未声称获得结构化场景 API。

Chrome 使用已有 profile 的官方方式是 Chrome 144+ 手动开启 `chrome://inspect/#remote-debugging`，MCP 使用 `--autoConnect`，用户接受调试连接提示。本轮用户改用内建浏览器，因此没有修改 Chrome profile、复制登录数据或修改 MCP 配置。[Chrome DevTools MCP 官方说明](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance)
