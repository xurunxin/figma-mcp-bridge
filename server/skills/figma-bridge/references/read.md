# 读取与定位

先运行 `tools describe get_metadata`，使用 `get_metadata` 核对文件名、页面和编辑器信息，再根据需要调用 `get_selection` 或 `get_design_context`。`get_document` 返回当前页面树，不代表整个文件所有页面。

需要精确属性时使用 `get_node`。节点 ID 使用冒号形式，例如 `12:34`；实例子节点可使用 `I12:34;56:78`，不要替换成 URL 中的连字符形式。

`get_styles`、`get_variable_defs` 读取现有样式与变量，不提供完整的样式和变量创建能力。Motion 工具依赖 Figma 当前运行环境的相关 API；不将 API 不可用当作成功。

示例参数文件：

```json
{ "nodeId": "12:34" }
```

```text
figma-bridge call get_node --input node.json --file-key <连接标识>
```
