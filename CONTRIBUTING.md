# Contributing

Muny is in early development.

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
- Record significant technical choices in [docs/DECISIONS.md](docs/DECISIONS.md).
- Update the status column in [docs/FEATURES.md](docs/FEATURES.md) and the checkboxes in [docs/ROADMAP.md](docs/ROADMAP.md) as work lands.

## Easy ways to help (once public)

- Add entries to the **alternatives catalog** (paid service → self-hosted/FOSS alternative).
- Add **CSV import presets** for your bank (with synthetic sample data only).

## Ground rules

- No real financial data in issues, PRs, fixtures or screenshots.
- Read [SECURITY.md](SECURITY.md) before touching auth, providers or the agent API.
