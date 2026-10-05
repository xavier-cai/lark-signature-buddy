# Lark Signature Buddy

A privacy-first image slicer for Lark and Feishu signatures. The browser tool
prepares a compact configuration string; the companion bot combines it with
the original image, renders the tiles, uploads them to Lark, and returns
reusable image keys.

> This project is not affiliated with or endorsed by Lark or ByteDance.

## Highlights

- Local-first editor: uploaded images stay in the browser until you send the
  original image and generated configuration string to your bot.
- Static and animated inputs: PNG, GIF, APNG, and browser-supported WebP.
- Lazy animation editing: supported browsers decode visible frames on demand,
  while the frame picker virtualizes long animations.
- Precise grids: 1–13 columns and 1–5 rows, independent preview/pre-crop
  spacing controls, and optional luminance-to-alpha mapping.
- Shared core: the browser and bot consume the same strict recipe, grid,
  resource-limit, animation, and tile-planning modules.
- Static deployment: the web tool builds to one self-contained `dist/index.html`
  and can run on GitHub Pages.

The UI and bot responses are currently written in Simplified Chinese.

## Architecture

```text
lark-signature-buddy/
├── apps/
│   ├── web/                 # Browser-only editor and configuration generator
│   └── bot/                 # Lark event consumer, image I/O, rendering/upload
├── packages/
│   └── core/                # Shared protocol, grid, codecs, limits, tile plan
├── deploy/systemd/          # Optional user-service template
├── docs/                    # Protocol and deployment documentation
├── scripts/                 # Reproducible build entry points
└── tests/                   # Unit and integration-style module tests
```

The dependency direction is intentionally one-way:

```text
apps/web ─┐
          ├──> packages/core
apps/bot ─┘
```

`packages/core` does not depend on browser UI or Lark CLI behavior. The bot owns
Lark messages and native image rendering; the web app owns DOM and clipboard
interaction.

## Requirements

- Node.js 22 or newer
- npm
- A Chromium-based browser for the broadest animated WebP support
- For the bot only:
  - `lark-cli` available on `PATH`
  - a Lark application with bot capability
  - event subscription `im.message.receive_v1`
  - permissions `im:message:send_as_bot`, `im:message:readonly`, and
    `im:resource`

## Quick start

```bash
git clone https://github.com/xavier-cai/lark-signature-buddy.git
cd lark-signature-buddy
npm ci
npm run security:install
npm run security:hooks
npm run check
```

Build the web application:

```bash
npm run build
```

Open `dist/index.html` through an HTTPS or local development server. The file is
self-contained and can also be embedded as an HTML5 document block.

## Run the bot

The bot uses a Lark long-lived connection and does not require a public webhook.
Create a `lark-cli` profile without putting the app secret in this repository:

```bash
read -rsp 'App Secret: ' LSB_APP_SECRET
printf '\n'
printf '%s' "$LSB_APP_SECRET" | lark-cli profile add \
  --name lark-signature-buddy \
  --app-id '<your-app-id>' \
  --app-secret-stdin
unset LSB_APP_SECRET
```

Start the process:

```bash
npm run start:bot
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LARK_SIGNATURE_BUDDY_PROFILE` | `lark-signature-buddy` | `lark-cli` profile |
| `LARK_SIGNATURE_BUDDY_REQUEST_TTL_MS` | `600000` | Partial request lifetime |

The provided user-service template assumes this repository lives at
`~/workspace/opensource/lark-signature-buddy`:

```bash
mkdir -p ~/.config/systemd/user
ln -sfn \
  "$PWD/deploy/systemd/lark-signature-buddy.service" \
  ~/.config/systemd/user/lark-signature-buddy.service
systemctl --user daemon-reload
systemctl --user enable --now lark-signature-buddy.service
```

## GitHub Pages

The included Pages workflow builds and deploys `dist/`. After pushing the
repository, select **GitHub Actions** as the Pages source in repository
settings. The bot remains a separate long-running process and is not hosted by
GitHub Pages.

## Protocol compatibility

This rewrite deliberately has no compatibility layer. It accepts only the
`LSB1:` recipe described in [docs/protocol.md](docs/protocol.md). Transport
images produced by earlier Image Buddy builds, including `IB4:`, are rejected.

## Development

```bash
npm test       # Node test runner
npm run lint   # ESLint
npm run build  # self-contained static application
npm run check  # all of the above
npm run security:audit         # tracked files and reachable history
npm run security:audit:release # history plus untracked release candidates
npm run security:audit:remote  # remote branches, tags, and PR heads
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Security issues should follow [SECURITY.md](SECURITY.md), not public issues.

## Privacy and security

- The web tool performs image decoding, previews, cropping, and configuration
  generation locally.
- The bot receives only images and configuration strings explicitly sent to
  its Lark conversation.
- App credentials belong in the operating-system keychain through a
  `lark-cli` profile, never in source, command arguments, logs, or GitHub
  Actions.
- Temporary bot files are created under the operating-system temporary
  directory and removed after processing.
- Gitleaks v8.30.1 is installed from its official release with a pinned
  SHA-256 digest. Local commit/push hooks and GitHub CI block detected private
  keys or credentials with fully redacted scanner output. GitHub Secret
  Scanning and Push Protection provide the hosted boundary.

See [docs/security-gates.md](docs/security-gates.md) for the complete gate map
and release procedure.

## License

[MIT](LICENSE)
