# Image Buddy Local

本地运行、可嵌入飞书文档的图片上传工具。浏览器只访问本地服务，服务端通过
`lark-cli` 的 `image-buddy` profile 调用飞书上传图片 API；App Secret 不会发送到前端。

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
