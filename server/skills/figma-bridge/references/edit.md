# 创建与编辑

按需查询 `create_page`、`create_frame`、`create_text`、`create_shape` 的 Schema。使用返回的节点 ID 作为后续 `parentId`，避免猜测层级。文本创建和修改需要字体可用，错误时选择已安装字体或先解决字体问题。

几何属性使用 `set_node_properties`，颜色使用 `set_solid_fill`，渐变使用 `set_gradient_fill`，效果使用 `set_effects`，布局使用 `set_auto_layout`。复杂属性先读取当前节点，按任务修改需要的字段。

组织节点可用 `duplicate_nodes`、`reparent_nodes`、`group_nodes`、`ungroup_node`。`set_selection` 与 `scroll_and_zoom_into_view` 可用于定位结果。

创建 Frame 的参数示例：

```json
{ "name": "CLI 验收", "width": 640, "height": 360, "x": 0, "y": 0 }
```

每一步持久记录成功返回的节点 ID。批量任务中断后先查询实际画布，不能以命令失败推断它没有产生修改。仅清理本次任务创建并已核实身份的节点。
