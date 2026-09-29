# Image Buddy

飞书文档内的离线网格切图工具，以及配套的图片 Key Bot。

## 项目结构

```text
image-buddy-local/
├── public/
│   ├── index.html       # 切图页面
│   ├── app.js           # 选区、切图和剪贴板交互
│   ├── grid-core.js     # 网格与裁剪算法
│   └── styles.css       # 页面样式
├── bot.mjs              # 飞书长连接消费者
├── bot-core.mjs         # image_key 提取、聚合和回复格式
├── build-widget.mjs     # 构建单文件 HTML5 Block
├── project.test.mjs     # 算法与 Bot 逻辑测试
├── systemd/
│   └── image-buddy-bot.service
└── package.json
```

## 使用流程

1. 在飞书文档的 HTML5 Block 中上传、拖拽或粘贴原图。
2. 输入列数和行数（各 1–15），调整选区、模式与渲染间隔。
3. 点击主按钮，按 `复制第 X/N 张` 的提示逐张复制。
4. 每复制一张就粘贴发送给“图片仔”Bot。
5. Bot 将同一用户在短时间内连续发送的图片聚合起来，统一回复全部
   `image_key` 和对应的 `https://magic.solutionsuite.cn/r?k=...` 链接。

浏览器剪贴板无法可靠地一次写入多张独立图片，所以工具刻意使用逐张复制队列。
每次剪贴板中只有一张真实 PNG，不会产生 `tile-1.pngtile-2.png...` 文本。

## 构建文档组件

```bash
npm run build:widget
```

产物位于 `dist/image-buddy-widget.html`。它是单文件离线 HTML，不依赖 Web
Host，也不包含飞书 App Secret。

## 启动 Bot

Bot 使用飞书长连接，不需要公网 Webhook Host：

```bash
npm run start:bot
```

可选环境变量：

- `IMAGE_BUDDY_PROFILE`：Lark CLI profile，默认 `image-buddy`
- `IMAGE_BUDDY_BATCH_DELAY_MS`：连续图片静默聚合窗口，默认 `1500`
- `IMAGE_BUDDY_MAX_BATCH_MS`：单批最长等待，默认 `5000`

应用需启用机器人能力，订阅 `im.message.receive_v1`，并开通单聊/群聊接收消息和
`im:message:send_as_bot` 权限。

## systemd 常驻

项目内保存了可审查的 unit 模板：

```text
systemd/image-buddy-bot.service
```

安装或更新（使用符号链接，项目内模板是唯一来源）：

```bash
mkdir -p ~/.config/systemd/user
ln -sfn \
  "$PWD/systemd/image-buddy-bot.service" \
  ~/.config/systemd/user/image-buddy-bot.service
systemctl --user daemon-reload
systemctl --user enable --now image-buddy-bot.service
```

如果项目不在 `~/workspace/opensource/image-buddy-local`，先同步修改 unit 中的
`WorkingDirectory` 和 `ExecStart`。

查看状态和日志：

```bash
systemctl --user status image-buddy-bot.service
journalctl --user -u image-buddy-bot.service -f
```

停止：

```bash
systemctl --user disable --now image-buddy-bot.service
```

## App Secret 管理

App Secret 不属于项目文件，也不写入 systemd unit、环境变量文件、源码或 Git。
使用 `lark-cli` profile 管理：

```bash
read -rsp 'App Secret: ' IMAGE_BUDDY_SECRET
printf '\n'
printf '%s' "$IMAGE_BUDDY_SECRET" | lark-cli profile add \
  --name image-buddy \
  --app-id cli_aa31b54ea9b85bcf \
  --app-secret-stdin
unset IMAGE_BUDDY_SECRET
```

当前机器上，`~/.lark-cli/config.json` 权限为 `0600`，只保存
`source: keychain` 的引用；实际 Secret 存储在操作系统原生 keychain 中。
`image-buddy-bot.service` 只配置 profile 名 `image-buddy`，运行时由
`lark-cli` 从 keychain 取 Secret，因此不会把 Secret 暴露在：

- Git 仓库
- systemd unit
- 进程参数
- shell history
- 服务日志

检查配置时使用：

```bash
lark-cli config show --profile image-buddy
```

该命令只显示掩码 `****`，不会回显 Secret。

轮换 Secret 时，不要在命令参数或聊天中传明文。先在飞书开放平台重置 Secret，
再从标准输入更新同名 profile；如果当前 CLI 不支持覆盖同名 profile，先停止 Bot，
显式移除并按上面的 `--app-secret-stdin` 命令重建 profile，最后重启服务。

## 测试

```bash
npm test
```

## 安全与运行边界

- 切图在浏览器内完成，原图不上传到本项目服务。
- Bot 不下载图片，只读取消息中的 `image_key`。
- Bot 以 `message_id` 去重，并为回复生成幂等 key。
- 长连接不需要公网 Host，但当前机器和 systemd 服务必须在线。
