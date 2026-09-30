# Security policy

## Supported versions

Only the current `master` branch is supported before the first tagged release.
After releases begin, only the latest release line will receive security fixes.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities or accidentally exposed
credentials. Use GitHub's **Report a vulnerability** flow in the repository
Security tab.

Include the affected version or commit, prerequisites, reproduction steps,
impact, and a minimal proof of concept. Remove real Lark credentials and user
images from all reports.

Maintainers will acknowledge a valid report within seven days and coordinate a
fix and disclosure timeline. If the report is not a vulnerability, the response
will explain why and may suggest a normal issue instead.

## Credential handling

Lark app secrets and tokens must remain in the deployment environment. Use a
`lark-cli` profile backed by the operating-system keychain. Never place secrets
in source files, `.env` files committed to Git, issue attachments, CI variables
that are available to untrusted pull requests, or command-line arguments.
