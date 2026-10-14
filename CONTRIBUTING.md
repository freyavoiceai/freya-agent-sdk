# Contributing

## Setup

```bash
npm install          # Node 22 recommended; also builds dist/
npm run verify       # what CI runs
```

## Rules

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Every change to the public API or behaviour adds a line under `## [Unreleased]` in `CHANGELOG.md` and updates the matching guide in `docs/`.
- A bug fix comes with a test that fails without it.
- No keys, tokens or customer data in code, tests, examples or fixtures.
- `src/agent/client.ts`, `types.ts` and `native-media-manager.ts` mirror `freya-dashboard/packages/freya-client`; change both or note why they differ.

## Releasing

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new version heading with today's date.
2. Set the same version in `package.json` (`npm version <x.y.z> --no-git-tag-version`).
3. Merge to `main`, then tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
4. The `release` workflow runs the checks, builds, and attaches `freya-agent-sdk-<x.y.z>.tgz` and `freya-agent-sdk.js` to a GitHub release.

Customers install from the tag (`github:freyavoiceai/freya-agent-sdk#v<x.y.z>`) or the release tarball.
