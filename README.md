# Figma MCP Bridge

通过 Figma 插件访问已打开的画布，支持 **CLI + Skills 按需调用**，也保留原有 MCP 入口。CLI 与 MCP 共用全部 39 个工具的校验和执行逻辑。Windows 桌面应用启停为首版支持范围。

## CLI 快速开始（无需配置 MCP）

本次新增 CLI 的代码尚未发布到 npm。先从本地构建包安装；最终用户安装这个包只需要 Node.js 20+，应用管理还需要 Windows 和 PowerShell 7，不需要 Bun 或源码。

```powershell
# 开发者构建本地交付包：先在根目录、server、plugin 各执行 bun install --frozen-lockfile
bun run build:package
cd server
npm pack
npm install -g ./gethopp-figma-mcp-bridge-0.2.0.tgz

# 用户/Agent 使用
figma-bridge doctor
figma-bridge skills install --target "X:/MyProject"
figma-bridge app open --target desktop
```

`doctor` 返回 `pluginManifest`。在 Figma 桌面版的测试文件中手动导入该路径的 `manifest.json`，然后运行插件。不要移动或删除插件目录。`app open` 打开成功只报告 `opened`，此时画布不一定可操作。

```powershell
figma-bridge files list
figma-bridge wait --file-key "files list 返回的连接标识" --timeout 60
figma-bridge tools describe create_frame
'{"name":"CLI 示例","width":400,"height":240}' | figma-bridge call create_frame --input - --file-key "连接标识"
figma-bridge tools describe get_node
'{"nodeId":"上一步返回的节点 ID"}' | figma-bridge call get_node --input - --file-key "连接标识"
figma-bridge bridge stop
```

`fileKey` 是插件连接标识，可能是临时值；不能从 URL 推导，多文件连接时必须显式选择。首次业务调用会自动启动桥接，10 分钟无业务调用且无执行中请求时退出。心跳和状态查询不延长空闲时间。

默认结果为 JSON，日志在 stderr。完整命令、错误码、应用所有权、路径规则和本地验收见 [CLI 使用说明](docs/cli.md)。[Chrome 扩展研究](research/README.md) 是独立且默认关闭的原型，尚未证明可以替代 Figma 插件。

[![Pairing with Hopp](https://gethopp.app/git/hopp-shield.svg?ref=hopp-repo)](https://gethopp.app)

- [Demo](#demo)
- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
- [Local development](#local-development)
- [Structure](#structure)
- [How it works](#how-it-works)

<br/>

<img src="https://raw.githubusercontent.com/gethopp/figma-mcp-bridge/main/logo.png" alt="Figma MCP Bridge" align="center" />

<br/>

Figma MCP Bridge reads and edits open documents through the Figma Plugin API. It does not call the official Figma MCP service. Drafts are a convenient testing location, not a prerequisite; file permissions and editor capabilities still apply.

It supports **multiple Figma files connected simultaneously**; open the plugin in each file and your AI agent can query any of them by `fileKey`. Single-file setups work exactly as before with no changes required.

It also includes a small, opt-in set of **write tools** for safe agent-driven edits — see [Editing Notes](#editing-notes) below.

## Demo

[Watch a demo of building a UI in Cursor with Figma MCP Bridge](https://youtu.be/ouygIhFBx0g)

[![Watch the video](https://img.youtube.com/vi/ouygIhFBx0g/maxresdefault.jpg)](https://youtu.be/ouygIhFBx0g)

## Quick Start

### 1. Add the MCP server to your favourite AI tool

Add the following to your AI tool's MCP configuration (e.g. Cursor, Windsurf, Claude Desktop):

```json
{
  "figma-bridge": {
    "command": "npx",
    "args": ["-y", "@gethopp/figma-mcp-bridge"]
  }
}
```

That's it — no binaries to download or install.

### 2. Add the Figma plugin

Download the plugin from the [latest release](https://github.com/gethopp/figma-mcp-bridge/releases) page, then in Figma go to `Plugins > Development > Import plugin from manifest` and select the `manifest.json` file from the `plugin/` folder.

### 3. Start using it 🎉

Open a Figma file, run the plugin, and start prompting your AI tool. The MCP server will automatically connect to the plugin.

To work across multiple files, just open the plugin in each Figma file. The bridge keeps all connections active and your AI agent can target any of them by `fileKey`.

If you want to know more about how it works, read the [How it works](#how-it-works) section.

## Available Tools

| Tool                           | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `list_files`                   | List all connected Figma files (supports multi-file workflows)                         |
| `get_document`                 | Get the current Figma page document tree                                               |
| `get_selection`                | Get the currently selected nodes in Figma                                              |
| `get_node`                     | Get a specific Figma node by ID (colon format, e.g. `4029:12345`)                      |
| `get_styles`                   | Get all local paint, text, effect, and grid styles                                     |
| `get_metadata`                 | Get file name, pages, and current page info                                            |
| `get_design_context`           | Get a depth-limited tree optimized for understanding design context                    |
| `get_variable_defs`            | Get all variable collections, modes, and values (design tokens)                        |
| `get_screenshot`               | Export nodes as PNG/SVG/JPG/PDF (base64-encoded)                                       |
| `save_screenshots`             | Export and save screenshots directly to the local filesystem                           |
| `get_motion_styles`            | List all available animation presets (beta)                                            |
| `get_node_motion`              | Read a node's current animation styles and properties (beta)                           |
| `apply_animation_style`        | Apply a preset animation style to a node (beta)                                        |
| `remove_animation_style`       | Remove an applied animation style from a node (beta)                                   |
| `apply_manual_keyframe_track`  | Apply a manual keyframe track to a node property (beta)                                |
| `remove_manual_keyframe_track` | Remove a manual keyframe track from a node property (beta)                             |
| `set_timeline_duration`        | Set the duration of a timeline in seconds (beta)                                       |
| `set_node_visibility`          | Show or hide specific nodes                                                            |
| `set_text_content`             | Replace the contents of a text node                                                    |
| `set_text_properties`          | Patch font, size, alignment, auto-resize, color, and bounds on a text node             |
| `set_node_properties`          | Patch common node properties: name, position, size, visibility, opacity, corner radius |
| `set_solid_fill`               | Replace a node's fill or stroke with a single solid paint                              |
| `set_gradient_fill`            | Replace a node's fill or stroke with a linear/radial/angular/diamond gradient          |
| `set_effects`                  | Replace a node's effects list (drop/inner shadows, layer/background blurs)             |
| `set_stroke_properties`        | Patch stroke weight, align, dash pattern, cap, and join                                |
| `set_auto_layout`              | Configure auto-layout direction, padding, gap, alignment, sizing, and wrap             |
| `create_page`                  | Create a new page in the document, optionally switching to it                          |
| `create_frame`                 | Create a new frame, optionally under a parent                                          |
| `create_text`                  | Create a new text node                                                                 |
| `create_shape`                 | Create a rectangle, ellipse, or line                                                   |
| `create_image`                 | Create an image-backed rectangle from a local path, URL, or data URI                   |
| `import_html_layers`           | Bulk-import an html-figma layer tree (JSON) as frames, text, rectangles, and vectors   |
| `duplicate_nodes`              | Duplicate nodes in place                                                               |
| `reparent_nodes`               | Move nodes into another parent                                                         |
| `group_nodes`                  | Wrap a list of nodes (sharing a parent) in a new group                                 |
| `ungroup_node`                 | Ungroup a group or frame — children move up to its parent                              |
| `set_selection`                | Set the page selection to a list of node IDs (works in Dev Mode)                       |
| `scroll_and_zoom_into_view`    | Frame the viewport around the given nodes (works in Dev Mode)                          |
| `delete_nodes`                 | Delete nodes with explicit confirmation                                                |

All tools accept an optional `fileKey` parameter when multiple Figma files are connected. Use `list_files` to discover connected files and their keys.

### Editing Notes

- Edit tools work only when the plugin is opened in Figma's design editor (Dev Mode is read-only — they will return a clear error there).
- The current user must have permission to edit the target file.
- `delete_nodes` is intentionally gated behind `confirm: true`.
- Text edits automatically load the fonts currently used by the target text node before applying the new content.
- New text nodes default to `Inter Regular` unless a font is provided.
- `create_image` reads local paths relative to the MCP server working directory unless you pass an absolute path.
- `import_html_layers` takes a JSON file produced by [html-figma](https://github.com/sergcen/html-to-figma)'s browser `htmlToFigma()`. The path resolves relative to the MCP server working directory and must stay inside it, even when absolute. Everything lands inside one wrapper frame, and the response reports `layerCount` against `expectedLayerCount` so partial imports are visible.
- `create_page` returns the new page's ID — pass it as `parentId` to `create_frame` / `create_text` / `create_shape` / `create_image` to author content on that page without switching the editor.

### What You Can Build

With the current write surface, an agent can build a basic slide deck in a new empty Figma file: create slide frames, style titles and body copy, lay out rectangles/ellipses/lines for cards and dividers, duplicate slide templates, reparent content into the right frame, and adjust common geometry/visual properties — including solid/gradient paints, shadows and blurs, stroke geometry, and auto-layout configuration.

The current version is intentionally limited — no components/instances, no variables/styles authoring, no per-segment text styling, and no vector boolean operations yet.

## Local development

This repo uses [Bun](https://bun.sh) as its package manager and script runner throughout. Install it first if you don't have it.

#### 1. Clone this repository locally

```bash
git clone git@github.com:gethopp/figma-mcp-bridge.git
```

#### 2. Install root tooling

Install the root dependencies once. This runs Husky's `prepare` script, which installs the Git pre-commit hook that formats staged files with Prettier.

```bash
cd figma-mcp-bridge && bun install
```

#### 3. Build the server

```bash
cd server && bun install && bun run build
```

#### 4. Build the plugin

```bash
cd plugin && bun install && bun run build
```

#### 5. Add the MCP server to your favourite AI tool

For local development, add the following to your AI tool's MCP config:

```json
{
  "figma-bridge": {
    "command": "node",
    "args": ["/path/to/figma-mcp-bridge/server/dist/index.js"]
  }
}
```

### Code style

The repo is formatted with [Prettier](https://prettier.io) (config in `.prettierrc`). A Husky pre-commit hook runs `lint-staged`, which formats only your staged files, so commits stay formatted automatically. You can also run it manually:

```bash
bun run format        # format the whole repo
bun run format:check  # verify formatting without writing (useful in CI)
```

## Structure

```
Figma-MCP-Bridge/
├── plugin/   # Figma plugin (TypeScript/React)
└── server/   # MCP server (TypeScript/Node.js)
    └── src/
        ├── index.ts      # Entry point
        ├── bridge.ts     # WebSocket bridge to Figma plugin
        ├── leader.ts     # Leader: HTTP server + bridge
        ├── follower.ts   # Follower: proxies to leader via HTTP
        ├── node.ts       # Dynamic leader/follower role switching
        ├── election.ts   # Leader election & health monitoring
        ├── tools.ts      # MCP tool definitions
        └── types.ts      # Shared types
```

## How it works

There are two main components to the Figma MCP Bridge:

### 1. The Figma Plugin

The Figma plugin is the user interface for the Figma MCP Bridge. You run this inside the Figma file you want to use the MCP server for, and its responsible for getting you all the information you need.

### 2. The MCP Server

The MCP server is the core of the Figma MCP Bridge. It maintains a registry of WebSocket connections keyed by `fileKey`, so multiple Figma files can be connected simultaneously. The server is responsible for:

- Handling WebSocket connections from one or more Figma plugin instances
- Routing tool calls to the correct file based on `fileKey`
- Forwarding responses back to the AI client
- Handling leader election (as we can have only one WS connection to an MCP server at a time)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FIGMA (Browser)                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Figma Plugin                                  │  │
│  │                    (TypeScript/React)                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket
                                      │ (ws://localhost:1994/ws)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PRIMARY MCP SERVER                                 │
│                         (Leader on :1994)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Bridge                                    Endpoints:               │    │
│  │  • Manages WebSocket conn                  • /ws    (plugin)        │    │
│  │  • Forwards requests to plugin             • /ping  (health)        │    │
│  │  • Routes responses back                   • /rpc   (followers)     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                           ▲                              ▲
                           │ HTTP /rpc                    │ HTTP /rpc
                           │ POST requests                │ POST requests
                           │                              │
         ┌─────────────────┴───────────┐    ┌─────────────┴───────────────┐
         │    FOLLOWER MCP SERVER 1    │    │    FOLLOWER MCP SERVER 2    │
         │                             │    │                             │
         │  • Pings leader /ping       │    │  • Pings leader /ping       │
         │  • Forwards tool calls      │    │  • Forwards tool calls      │
         │    via HTTP /rpc            │    │    via HTTP /rpc            │
         │  • If leader dies →         │    │  • If leader dies →         │
         │    attempts takeover        │    │    attempts takeover        │
         └─────────────────────────────┘    └─────────────────────────────┘
                    ▲                                      ▲
                    │                                      │
                    │ MCP Protocol                         │ MCP Protocol
                    │ (stdio)                              │ (stdio)
                    ▼                                      ▼
         ┌─────────────────────────────┐    ┌─────────────────────────────┐
         │      AI Tool / IDE 1        │    │      AI Tool / IDE 2        │
         │      (e.g., Cursor)         │    │      (e.g., Cursor)         │
         └─────────────────────────────┘    └─────────────────────────────┘
```
