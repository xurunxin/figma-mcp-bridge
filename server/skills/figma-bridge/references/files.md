# 导入与导出

`create_image` 的 `source` 支持工作目录内的文件、公开 HTTP(S) URL 或 base64 data URI。普通本地文件和网络图片上限为 32 MiB。网络地址校验、重定向限制和超时由 CLI 执行。

`import_html_layers` 的 `source` 是工作目录内的 JSON 文件，内容必须是 html-figma `htmlToFigma()` 产生的 LayerNode 树，不能直接传 HTML 字符串、网页 URL 或截图。JSON 上限为 16 MiB。

`get_screenshot` 返回 base64；需要文件时优先使用 `save_screenshots`，返回路径、尺寸等元数据。输出不得越过工作目录，不覆盖已有文件。支持 PNG、SVG、JPG、PDF；扩展名与显式格式必须一致。

```json
{
  "items": [{ "nodeId": "12:34", "outputPath": "artifacts/frame.png" }],
  "format": "PNG",
  "scale": 1
}
```

```text
figma-bridge call save_screenshots --input export.json --file-key <连接标识> --workspace <项目目录>
```

遇到 `PARTIAL_COMPLETION` 时读取 `error.details.results`：成功项的文件已经写入。修复失败项并使用新路径，避免覆盖或重复导出。
