# Contributing

Thanks for helping improve Lark Signature Buddy.

## Development workflow

1. Open an issue for behavior changes that affect the transport format, Lark
   permissions, or user-visible workflow.
2. Create a focused branch from an up-to-date `master`.
3. Install dependencies with `npm ci`.
4. Keep shared domain rules in `packages/core`; do not duplicate them in both
   applications.
5. Add or update tests for behavioral changes.
6. Run `npm run check`.
7. Open a pull request using the repository template.

## Architecture rules

- `apps/web` may depend on `packages/core`, browser APIs, and browser-safe
  packages.
- `apps/bot` may depend on `packages/core`, `lark-cli`, and Node/native image
  packages.
- `packages/core` must not import from either application.
- Protocol changes are intentionally strict. Change the protocol marker or
  version and document the break; do not add silent compatibility fallbacks.
- Never commit Lark app IDs tied to private deployments, app secrets, access
  tokens, downloaded user images, or generated transport artifacts.

## Pull requests

Keep pull requests small enough to review. Explain the user impact, architecture
impact, compatibility impact, and exact verification commands. CI must pass
before merge. Prefer squash merge so each pull request becomes one coherent
change on the default branch.

By contributing, you agree that your contribution is licensed under the MIT
License.
