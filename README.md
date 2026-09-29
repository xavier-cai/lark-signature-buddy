# Image Buddy

飞书文档内的网格切图参数工具，以及配套的图片 Key Bot。

## 项目结构

```text
image-buddy-local/
├── public/
│   ├── index.html       # 切图页面
│   ├── app.js           # 选区与剪贴板交互
│   ├── image-recipe.js  # 前端与 Bot 共用的严格版本协议
│   ├── image-format.js  # 静态图/动图格式与尺寸检查
│   ├── animation-core.js # GIF/APNG/WebP 解码与 GIF/APNG 编码
│   ├── transport-core.js # 传输画布与 QR 尺寸计算
│   ├── grid-core.js     # 网格与裁剪算法
│   └── styles.css       # 页面样式
├── bot.mjs              # 飞书长连接消费者
├── bot-core.mjs         # image_key 提取、聚合和回复格式
├── bot-image.mjs        # 消息图片下载与 QR 解码
├── bot-tiles.mjs        # 服务端切图、上传与顺序编排
├── build-widget.mjs     # 构建单文件 HTML5 Block
├── project.test.mjs     # 算法与 Bot 逻辑测试
├── test-fixtures/
│   └── animated-apng.png # APNG 多帧回归样例
├── systemd/
│   └── image-buddy-bot.service
└── package.json
```

## 使用流程

1. 在飞书文档的 HTML5 Block 中上传、拖拽或粘贴原图。
2. 输入列数和行数（各 1–15），调整选区、模式与渲染间隔；动图可在网格
   控制区下方选择任意帧作为裁剪参考。
3. 按需切换色彩映射（默认开启），并通过“原始色彩 / 色彩映射后”双预览对比
   最终组合效果。
4. 点击主按钮，生成“原图区域 + 紧凑 QR”的中间传输图片。静态图使用 PNG，
   动图使用兼容飞书消息的 GIF。
5. 粘贴发送给“图片仔”Bot。
6. Bot 下载图片，扫描并严格校验 V4 协议，按同一套网格算法生成子图，并根据
   QR 中的开关决定是否执行色彩映射。
7. Bot 将子图逐张上传到飞书，并回复全部 `image_key` 和对应妙笔链接。

浏览器剪贴板无法可靠地一次写入多张独立图片，因此前端只生成一张视觉内容和
切图参数合成后的传输图片。原图不缩放；宽度不足 384 px 时左右补白，底部追加
紧凑高纠错 QR。后续由 Bot 使用同一份协议和网格算法生成子图，避免两端
对参数理解不同。

## 共享切图协议

`public/image-recipe.js` 是前端和 Bot 的共同依赖：

- 前端直接导入它来创建并编码 payload。
- 构建 HTML5 Block 时，它会与页面脚本一起内联。
- Bot 直接导入它来提取、解码和严格校验 payload。

当前只支持紧凑二进制 `IB4`。协议标记、payload 版本、字段集合或参数范围
不一致时直接报错，不做任何前向或向后兼容。

V4 字段包含：

- 原图宽高
- 静态/动图标记与帧数
- 网格行列数
- 归一化选区 `x/y/width/height`
- `plain` / `precut` 模式
- 间隔比例
- 色彩映射开关
- 目标子图宽高和格式

编码后的 V4 token 固定不超过 64 个 ASCII 字符，写入纠错等级 H 的二维码。
payload 额外记录原图在传输画布中的归一化 `contentRect`，Bot 后续可先剥离
padding 和 QR 区域，再对原图执行切分。QR 不带标题和额外留白，仅保留标准
4-module quiet zone；当前协议为 41 modules，按 1 px/module 约 49×49 px。
切片结果按从左到右、从上到下排序。

V4 前端可读取 GIF、APNG 和 Animated WebP：GIF 使用内置解码器，APNG 使用
UPNG，Animated WebP 使用 Chromium `ImageDecoder`。动图中间传输统一编码为
GIF，保留帧数、帧时长和循环信息；图片仔切片后统一输出 APNG。前端展示全部帧
缩略图，并按原始帧时长播放最终组合预览。最多 120 帧、80 MP 总帧像素工作量、
20 MB 传输文件。

色彩映射开关写入 QR，不预处理传输图。图片仔切片后按文档方案将每个像素的 RGB
转成加权亮度
`0.2126R + 0.7152G + 0.0722B`，再以 `(255 - 亮度) × 原透明度` 生成新透明度。
静态 PNG 与 APNG 均保留完整 8-bit 半透明通道。

Bot 最多接受 15×15（225 张）切片，使用 4 个 worker 执行“裁剪一张 → 写入
临时文件 → 上传 → 删除临时文件”。静态子图输出 512×512 PNG，动图子图输出
512×512 APNG；RGBA、帧时长和循环信息保持不变。只有整批上传
成功才回复妙笔链接；中途失败会返回批次错误，不返回不完整链接列表。

页面在每次生成后显示实际中间传输图、画布尺寸、协议长度和下载链接。静态 PNG
与动图 GIF 均优先通过原生剪贴板复制；浏览器不支持对应格式时提供下载方式。

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
`im:message:send_as_bot`、`im:message:readonly`、`im:resource` 权限。

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

- 选区和参数编码在浏览器内完成，原图通过用户粘贴上传到飞书。
- Bot 下载消息图片、扫描 QR、生成并上传子图，再回复妙笔链接。
- Bot 以 `message_id` 去重，并为回复生成幂等 key。
- 长连接不需要公网 Host，但当前机器和 systemd 服务必须在线。
