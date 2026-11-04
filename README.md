# Muny

**Self-hosted personal finance and subscription manager, built for AI agents to use.**

Muny tracks your accounts, transactions, budgets, recurring bills and subscriptions. It runs in one container on your own hardware, so your financial data stays on your machine. It also gives AI agents a scoped, permissioned way to read your data. They can then help you find savings, including subscriptions you could replace with self-hosted or DIY alternatives.

> **Status:** Pre-alpha / planning. Nothing is runnable yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Why

Commercial tools like Rocket Money work well, but they cost a monthly subscription and hold all your financial data on someone else's servers. Muny aims to:

1. **Match the core feature set** of commercial subscription/budget trackers ([feature parity matrix](docs/FEATURES.md)).
2. **Keep the data yours.** It is self-hosted, uses SQLite, has no telemetry, and you can export everything.
3. **Be AI-native.** It includes an MCP server and REST API so agents (Claude, local LLMs, etc.) can analyze spending and suggest savings.
4. **Track the DIY path.** It records which subscriptions could be replaced with self-hosted or home-built tools and what that would actually save.

## Documentation

| Doc | Purpose |
|---|---|
| [docs/VISION.md](docs/VISION.md) | Goals, non-goals, guiding principles |
| [docs/FEATURES.md](docs/FEATURES.md) | Rocket Money parity matrix + Muny-only features |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Tech stack, components, data model |
| [docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md) | MCP server, agent API, permission model, privacy |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision log |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker / Synology NAS deployment |
| [SECURITY.md](SECURITY.md) | Security model and vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup and contribution guidelines |

## License

To be decided before the first public release (see [docs/DECISIONS.md](docs/DECISIONS.md)).
