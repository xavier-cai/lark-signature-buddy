# Image Buddy Local

可嵌入飞书文档的离线网格切图工具，以及配套的飞书图片 Key Bot。

- 文档 HTML5 Block 在浏览器内完成选区、切图和复制，不需要 Host。
- 用户把复制的图片粘贴发送给“图片仔”。
- Bot 通过飞书长连接接收图片消息，聚合后回复所有 `image_key` 和完整妙笔链接。

支持：

- 上传、拖拽或粘贴图片，入口始终可见
- 用户输入列数和行数，各自支持 1–15（最多 15×15）
- 在操作画布中拖动网格位置、通过四角等比缩放
- 最终组合预览始终显示实际渲染间隔
- 无间隔切图：源图连续切分，渲染时仍展示间隔
- 预裁剪间隔：源图切分时跳过将被渲染间隔占据的区域
- 渲染间隔默认按子图边长的 58% 预留，可实时调节
- 一次生成所有 PNG 子图，支持逐张复制和富文本批量复制
- Bot 聚合同一用户短时间内连续发送的图片，统一回复 Key 和链接

## 切图页面（开发预览，可选）

```bash
IMAGE_BUDDY_ACCESS_TOKEN="$(openssl rand -hex 24)" npm start
```

可选环境变量：

- `IMAGE_BUDDY_PORT`：监听端口，默认 `32180`
- `IMAGE_BUDDY_HOST`：监听地址，默认 `0.0.0.0`
- `IMAGE_BUDDY_PROFILE`：Lark CLI profile，默认 `image-buddy`
- `IMAGE_BUDDY_ACCESS_TOKEN`：页面与上传接口共用的随机访问令牌；未设置时启动时自动生成

启动日志会打印带 `token` 的完整访问地址。

飞书文档中的构建产物 `dist/image-buddy-widget.html` 是单文件离线 HTML，不依赖该
HTTP 服务。

## 启动 Bot

前提：`image-buddy` profile 对应的应用已配置长连接事件订阅
`im.message.receive_v1`，并开通接收消息和回复消息权限。

```bash
npm run start:bot
```

可选环境变量：

- `IMAGE_BUDDY_PROFILE`：Lark CLI profile，默认 `image-buddy`
- `IMAGE_BUDDY_BATCH_DELAY_MS`：连续图片静默聚合窗口，默认 `1500`
- `IMAGE_BUDDY_MAX_BATCH_MS`：单批最长等待，默认 `5000`

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
- Bot 用 `message_id` 去重并为回复生成幂等 key
- 长连接无需公网 webhook host，但必须保持 Bot 进程在线

这是临时本地服务，不适合作为长期生产部署。
