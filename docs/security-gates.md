# Secret and private-key gates

Lark Signature Buddy uses layered, fail-closed secret detection. The repository
does not implement a browser-side “private key login”: client-side code cannot
keep a private secret. These gates instead prevent private keys and credentials
from entering source history or reaching GitHub.

## Gate map

| Layer | Location | Coverage |
| --- | --- | --- |
| Staged changes | `.githooks/pre-commit` | Complete staged diff and file content |
| Outgoing commits | `.githooks/pre-push` | Every commit range sent to a remote |
| Pull requests and `master` | `.github/workflows/ci.yml` | Tracked files and complete reachable history |
| Pages deployment | `.github/workflows/pages.yml` | Same audit before upload and deployment |
| Release candidate | `npm run security:audit:release` | Tracked plus unignored untracked files and local history |
| Hosted refs | `npm run security:audit:remote` | Remote branches, tags, and pull-request heads in an isolated bare repository |
| GitHub boundary | Repository settings | Secret Scanning and Push Protection |

## Setup

```bash
npm run security:install
npm run security:hooks
```

The installer downloads Gitleaks v8.30.1 from the official GitHub release,
verifies the platform-specific SHA-256 digest, and writes the binary under the
ignored `.tools/bin/` directory. The runtime wrapper rejects missing or
different Gitleaks versions. Every scan explicitly loads the repository-owned
`.gitleaks.toml`, which extends the built-in rules, and removes inherited
`GITLEAKS_CONFIG` / `GITLEAKS_CONFIG_TOML` values so caller configuration cannot
replace the gate policy.

All scans use `--redact=100`; findings do not print secret values. A missing
scanner, unsupported platform, checksum mismatch, or scan failure rejects the
commit, push, CI run, or Pages deployment instead of silently skipping the gate.
Known false positives may be suppressed only by an exact Gitleaks fingerprint in
`.gitleaksignore`, after reviewing the referenced historical line with its value
redacted. Broad rule, path, or pattern allowlists are not accepted.

## Release audit

Before tagging or publishing a release:

```bash
npm run security:audit:release
npm run security:audit:remote
npm run check
```

If a credential has ever reached a remote, revoke or rotate it immediately.
Deleting a file or rewriting a branch is not credential remediation.
