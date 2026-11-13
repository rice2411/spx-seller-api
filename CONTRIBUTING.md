# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Setup

Requires Node.js 22+.

```bash
npm install
npm test
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Build CJS + ESM + type definitions into `dist/` (tsup) |
| `npm run dev` | Rebuild on change |
| `npm test` / `npm run test:watch` | Unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run typecheck` | `tsc --noEmit` |

Tests must not hit the network or use real credentials — mock `fetch` instead.
**Never commit cookies or session files.**

## Protocol notes

How the portal talks to SPX's APIs (cookies, envelopes, login flow) is documented in
[docs/PROTOCOL.md](docs/PROTOCOL.md). Please update it when you discover something new.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`, `docs: …`, `refactor: …`,
`chore: …`. Mark breaking changes with `!` (`feat!: …`).

## Releasing (maintainers)

1. Bump `version` in `package.json` and move the _Unreleased_ notes in `CHANGELOG.md` under the new version.
2. Commit, then tag and push: `git tag vX.Y.Z && git push --tags`.
3. The `Release` workflow tests, builds and publishes to npm (Trusted Publishing, with provenance) and creates the
   GitHub release.
