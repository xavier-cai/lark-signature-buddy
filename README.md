# Image Buddy Local

本地运行、可嵌入飞书文档的网格切图与上传工具。浏览器完成选区和切图，服务端通过
`lark-cli` 的 `image-buddy` profile 调用飞书上传图片 API；App Secret 不会发送到前端。

支持：

- 上传、拖拽或粘贴图片，入口始终可见
- 用户输入列数和行数，各自支持 1–15（最多 15×15）
- 在操作画布中拖动网格位置、通过四角等比缩放
- 最终组合预览始终显示实际渲染间隔
- 无间隔切图：源图连续切分，渲染时仍展示间隔
- 预裁剪间隔：源图切分时跳过将被渲染间隔占据的区域
- 渲染间隔默认按子图边长的 58% 预留，可实时调节
- 一次生成所有 PNG 子图并上传，逐张返回 `image_key`

## 启动

```bash
IMAGE_BUDDY_ACCESS_TOKEN="$(openssl rand -hex 24)" npm start
```

可选环境变量：

- `IMAGE_BUDDY_PORT`：监听端口，默认 `32180`
- `IMAGE_BUDDY_HOST`：监听地址，默认 `0.0.0.0`
- `IMAGE_BUDDY_PROFILE`：Lark CLI profile，默认 `image-buddy`
- `IMAGE_BUDDY_ACCESS_TOKEN`：页面与上传接口共用的随机访问令牌；未设置时启动时自动生成

启动日志会打印带 `token` 的完整访问地址。

## 测试

```bash
npm test
```

## 安全边界

- 文件最大 10 MB
- 只接受受支持图片格式的文件签名
- 每个来源地址每分钟最多请求 20 次
- 图片仅在内存中转，不写入磁盘
- App Secret 由 `lark-cli` profile 保管
- 页面通过随机 token 控制访问

这是临时本地服务，不适合作为长期生产部署。
