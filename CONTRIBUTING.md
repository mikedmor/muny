# Contributing

Thanks for helping. Muny is a stable 1.x release: changes keep existing installs working, and anything that needs people to act on upgrade waits for a major version.

## Dev setup

Requirements: **Node.js 24+**. pnpm is pinned in `package.json` and provided by Corepack:

```sh
corepack enable pnpm     # or, without admin rights on Windows:
                         # corepack enable --install-directory "%APPDATA%
pm" pnpm
pnpm install
cp .env.example .env     # optional for now
pnpm dev                 # API on :8420, web UI with hot reload on http://localhost:5173
```

| Command            | What it does                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `pnpm dev`         | Run server (tsx watch) + web (Vite) together                            |
| `pnpm test`        | Run all tests (Vitest)                                                  |
| `pnpm check`       | Lint + typecheck + test, which is what CI runs                          |
| `pnpm format`      | Auto-format and organize imports (Biome)                                |
| `pnpm build`       | Production build: `apps/web/dist` + bundled `apps/server/dist/index.js` |
| `pnpm db:generate` | Generate a new SQL migration after editing `packages/db/src/schema.ts`  |

Local data lives in `data-local/` (git-ignored). Delete it to start fresh.

### Repo layout

```
apps/server      Fastify API, serves the built web UI, runs migrations on start
apps/web         React + Vite + Tailwind SPA
packages/db      Drizzle schema, SQL migrations, DB client
packages/shared  Types and helpers shared by server and web (money, API types)
```

### Database migrations

Edit `packages/db/src/schema.ts`, then run `pnpm db:generate` (use `--name <what_changed>` via `pnpm --filter @muny/db exec drizzle-kit generate --name ...`). Commit the generated SQL. **Never edit a migration that has been released**; add a new one.

## Workflow

- `main` is always releasable. Work on branches named `feat/…`, `fix/…`, `docs/…`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Explain significant technical choices in the pull request description.
- Update the user guides in [guides/](guides/README.md) when you change how something is set up or used.

## Releases

Versions follow [Semantic Versioning](https://semver.org/) and every package in the workspace shares one version. To release:

1. `pnpm version:set 1.2.0`
2. Move the `[Unreleased]` notes in [CHANGELOG.md](CHANGELOG.md) under `## [1.2.0] - YYYY-MM-DD` and update the links at the bottom.
3. Commit (`chore(release): 1.2.0`), push, then push the tag: `git tag v1.2.0 && git push origin v1.2.0`.

The Release workflow checks the tag matches `package.json` and has a changelog entry, runs `pnpm check`, publishes `ghcr.io/mikedmor/muny` for amd64 and arm64 (tagged `1.2.0`, `1.2`, `1` and `latest`) and creates the GitHub release from the changelog.

## Easy ways to help

- Add entries to the **alternatives catalog** (paid service → self-hosted/FOSS alternative).
- Add **CSV import presets** for your bank (with synthetic sample data only).

## Ground rules

- No real financial data in issues, PRs, fixtures or screenshots.
- Read [SECURITY.md](SECURITY.md) before touching auth, providers or the agent API.
