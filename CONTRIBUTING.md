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
- `src/agent/client.ts`, `types.ts` and `native-media-manager.ts` mirror the client the Freya dashboard serves; change both or note why they differ.

## Releasing

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new version heading with today's date.
2. Set the same version in `package.json` (`npm version <x.y.z> --no-git-tag-version`).
3. Merge to `main`, then tag that commit: `git tag v<x.y.z> && git push origin v<x.y.z>`.
4. The `release` workflow checks that the tag is on `main` and matches `package.json` and the changelog, runs the checks and packs the tarball, without write access.
5. Its `publish` job waits for a maintainer's approval in the `npm` environment, then publishes that tarball to npm with provenance and attaches it, `freya-agent-sdk.js` and `THIRD_PARTY_NOTICES.txt` to a GitHub release.

Customers install `@freyavoice/agent-sdk` from npm.
