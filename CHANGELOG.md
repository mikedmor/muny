# Changelog

All notable changes to Muny are listed here. Versions follow [Semantic Versioning](https://semver.org/): a major version can need you to do something when you upgrade, minor versions add features, and patches fix things. Database migrations always run on their own when Muny starts.

## [Unreleased]

## [1.0.0] - 2026-11-07

The first stable release. Muny covers what Rocket Money does for budgeting and subscriptions, runs in one container on your own hardware, and lets AI assistants work with your data under permissions you set.

### Accounts and transactions

- Bank sync through your own Plaid or Teller keys, on a schedule, plus manual accounts.
- Import Rocket Money exports, bank CSV and OFX files, brokerage and Koinly exports, with duplicate detection.
- Automatic categories, your own categories and groups, rules, split transactions, notes, tags, and hiding or leaving things out of budgets.
- Merchant name cleanup, transfer and card payment matching, search and filters.

### Subscriptions and bills

- Recurring charges and income found automatically, with costs per month and year, what's coming up, and a calendar.
- Price rises, free trials ending, charges after you cancel, and series that survive a merchant renaming itself.

### Budgets

- Monthly budgets by category with rollover, alerts as you near them, and a forecast for the rest of the month.
- Budget basics: Earnings, Home & utilities, Bills & subscriptions and All other categories, each worked out from your categories.

### Overview, reports and net worth

- An Overview of cards you choose and arrange per screen size (phone to ultrawide), with a card editor that can calculate over all your data.
- Spending by category and merchant, month-over-month comparisons, cash flow, custom date ranges and net worth over time.
- Light, dark and your own color themes, with a live preview.

### Debts, savings and investments

- Loans with payoff dates, payoff plans (highest rate or smallest balance first), and reading loan statements.
- Credit cards with limits, statements, due dates and interest.
- Savings accounts with interest, earned rate and projections; categories inside an account.
- **Ways to save:** doubled-up subscriptions, price rises, self-hosted replacements, card interest, loan payoff order and idle cash, each with a yearly estimate.
- Stocks, crypto wallets and exchanges with cost basis and tax reports, and other assets like a home or car.

### AI

- An MCP server and REST API for AI assistants, with per-token permissions, rate limits and an activity log. Assistants can read, build Overview cards and themes, and suggest changes that wait in an inbox for your approval.
- Optional built-in AI (off by default): category suggestions, a monthly money review and help reading new statements, with Claude, any OpenAI-compatible server or Ollama.

### Running it

- One Docker image for amd64 and arm64, a SQLite database, automatic backups, and export of everything to CSV or JSON.
- Alerts in the app and through ntfy, Apprise, email, webhooks or phone push.
- Household members with owner and view-only roles.
- Demo mode (`MUNY_DEMO=true`) to try it with a made-up household.

[Unreleased]: https://github.com/mikedmor/muny/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mikedmor/muny/releases/tag/v1.0.0
