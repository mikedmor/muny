# Contributing to Muny

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

Muny is a stable 1.x release. Changes keep existing installs working, and anything that would need people to act when they upgrade waits for a major version.

## Ways to help

- **Report a bug or suggest an idea** in [GitHub issues](https://github.com/mikedmor/muny/issues). Include what you did, what you expected and what happened, plus relevant lines from `docker logs muny`. Never include real financial data.
- **Add to the self-hosted alternatives catalog** in [`packages/core/src/alternatives/catalog.ts`](packages/core/src/alternatives/catalog.ts): a paid service, how to recognise it on a statement, and its self-hosted or free alternatives. Keep entries factual, link to each project's own site, and say honestly what you give up.
- **Add a CSV preset for your bank** in [`packages/core/src/import/bank-csv.ts`](packages/core/src/import/bank-csv.ts), with a test using made-up rows.
- **Improve the guides** in [`guides/`](guides/README.md). If something confused you, it will confuse others.

Security problems go through [private reporting](SECURITY.md#reporting-a-vulnerability), not public issues.

## Development setup

You need **Node.js 24 or newer**. pnpm's version is pinned in `package.json` and provided by Corepack.

```sh
git clone https://github.com/mikedmor/muny.git && cd muny
corepack enable pnpm
pnpm install
cp .env.example .env   # optional: set MUNY_SECRET_KEY, bank sync keys, MUNY_DEMO=true
pnpm dev               # API on :8420, web UI with hot reload on http://localhost:5173
```

On Windows without admin rights, run `corepack enable --install-directory "%APPDATA%\npm" pnpm` instead of `corepack enable pnpm`.

Local data lives in `data-local/`, which git ignores. Delete it to start fresh. Set `MUNY_DEMO=true` in `.env` to start each fresh database with the demo household.

### Commands

| Command                    | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                 | Server (tsx watch) and web UI (Vite) together                                     |
| `pnpm test`                | All tests (Vitest)                                                                |
| `pnpm check`               | Lint, typecheck and tests: what CI runs, and what must pass before a pull request |
| `pnpm format`              | Format and organise imports (Biome)                                               |
| `pnpm build`               | Production build: `apps/web/dist` and the bundled `apps/server/dist/index.js`     |
| `pnpm db:generate`         | Generate a SQL migration after editing `packages/db/src/schema.ts`                |
| `pnpm version:set <x.y.z>` | Set the version of every package at once (for releases)                           |

### Repository layout

```
apps/server       Fastify API: serves the web UI, runs migrations on start, MCP and REST for assistants
apps/web          React, Vite and Tailwind single-page app
packages/core     Pure logic: importers, recurring detection, rules, crypto and brokerage parsing
packages/db       Drizzle schema, SQL migrations and the database client
packages/shared   Types and helpers shared by server and web: money, API types, card documents
guides/           User documentation
docker/           Compose files
```

### Database migrations

Edit `packages/db/src/schema.ts`, then run `pnpm db:generate` (or `pnpm --filter @muny/db exec drizzle-kit generate --name <what_changed>` to name it). Commit the generated SQL. **Never edit a migration that's been released**; add a new one.

## Conventions

- **Money is integer cents** with a currency code, everywhere. No floating point in anything that handles money.
- **Synthetic data only** in tests, fixtures, issues and screenshots. The demo household is a good source for screenshots.
- **Never log** account numbers, tokens, credentials or raw provider responses.
- **No new outbound network calls** unless they're opt-in and documented in the guide for the feature.
- **Assistant-facing features stay read-only by default.** Anything that changes data is scoped, can be dry-run, goes through the approval inbox where it touches money, and is audited.
- Read [SECURITY.md](SECURITY.md) before changing authentication, providers or the assistant API.

## Pull requests

- `main` is always releasable. Work on a branch named `feat/…`, `fix/…` or `docs/…`.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- Add or update tests for what you change, and make sure `pnpm check` passes.
- Update the [guides](guides/README.md) when you change how something is set up or used, and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Explain significant technical choices in the pull request description.

## Releases

Versions follow [Semantic Versioning](https://semver.org/), and every package in the workspace shares one version.

1. `pnpm version:set 1.2.0`
2. Move the `[Unreleased]` notes in [CHANGELOG.md](CHANGELOG.md) under `## [1.2.0] - YYYY-MM-DD`, and update the links at the bottom.
3. Commit (`chore(release): 1.2.0`) and push, then push the tag: `git tag v1.2.0 && git push origin v1.2.0`.

The Release workflow checks that the tag matches `package.json` and has a changelog entry, runs `pnpm check`, publishes `ghcr.io/mikedmor/muny` for amd64 and arm64 (tagged `1.2.0`, `1.2`, `1` and `latest`), and creates the GitHub release from the changelog.

## License

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0 license](LICENSE).
