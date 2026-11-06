# Muny

**Self-hosted personal finance and subscription manager, built for AI agents to use.**

Muny tracks your accounts, transactions, budgets, recurring bills and subscriptions. It runs in one container on your own hardware, so your financial data stays on your machine. It also gives AI agents a scoped, permissioned way to read your data. They can then help you find savings, including subscriptions you could replace with self-hosted or DIY alternatives.

> **Status:** Alpha. Muny runs day to day for its author (bank sync, budgets, recurring bills, alerts, crypto and stocks), but expect rough edges and breaking changes before 1.0.

## Why

Commercial tools like Rocket Money work well, but they cost a monthly subscription and hold all your financial data on someone else's servers. Muny aims to:

1. **Match the core feature set** of commercial subscription and budget trackers.
2. **Keep the data yours.** It is self-hosted, uses SQLite, has no telemetry, and you can export everything.
3. **Be AI-native.** It includes an MCP server and REST API so agents (Claude, local LLMs, etc.) can analyze spending and suggest savings.
4. **Track the DIY path.** It records which subscriptions could be replaced with self-hosted or home-built tools and what that would actually save.

## Documentation

Guides for installing and using Muny are in [guides/](guides/README.md):

- [Install](guides/install.md) with Docker, on a Synology NAS or any Docker host
- [Secure access](guides/access.md), [Bank sync](guides/bank-sync.md) and [Importing files](guides/importing.md)
- [Stocks](guides/stocks.md), [Crypto](guides/crypto.md), [Alerts](guides/alerts.md), [Backups and export](guides/backups.md)

See also [SECURITY.md](SECURITY.md) (security model and reporting vulnerabilities) and [CONTRIBUTING.md](CONTRIBUTING.md) (development setup).

## License

[GNU AGPL-3.0](LICENSE). You're free to use, modify and self-host Muny. If you run a modified version as a network service for others, you must make your source code available to its users.
