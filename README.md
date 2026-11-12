<div align="center">

<img src="apps/web/public/icons/icon-192.png" alt="" width="96" height="96" />

# Muny

**Self-hosted personal finance and subscription manager, built for AI assistants to use.**

Budgets, bills, subscriptions, loans, cards, savings, stocks and crypto in one container on your own hardware.
Your financial data never leaves your machine unless you decide it should.

[![CI](https://github.com/mikedmor/muny/actions/workflows/ci.yml/badge.svg)](https://github.com/mikedmor/muny/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mikedmor/muny?label=release)](https://github.com/mikedmor/muny/releases)
[![Docker image](https://img.shields.io/badge/ghcr.io-mikedmor%2Fmuny-2496ED?logo=docker&logoColor=white)](https://github.com/mikedmor/muny/pkgs/container/muny)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Support development](https://img.shields.io/badge/support-PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=79GR7CV7MKETG)

[Quick start](#quick-start) · [Features](#features) · [Screenshots](#screenshots) · [Documentation](guides/README.md) · [Changelog](CHANGELOG.md) · [Support](#support-the-project)

</div>

![The Overview: spending this month against last month and what's coming in, accounts, cards and loans](guides/images/overview.png)

## Why Muny

Commercial money apps work well, but they charge a monthly subscription and keep everything you own on someone else's servers. Muny gives you the same everyday tools without either:

- **Yours, end to end.** It runs on your NAS, home server or PC with a single SQLite file. No account with us, no telemetry, nothing phoning home, and you can export everything at any time.
- **Complete.** Budgets, recurring bills and subscriptions, spending reports, net worth, loans, credit cards, savings, stocks and crypto, with alerts to your phone.
- **Built for AI, on your terms.** An MCP server and REST API let assistants such as Claude read exactly what you allow, build dashboard cards for you, and _suggest_ changes that wait for your approval. Muny never moves money.
- **Helps you spend less.** It finds doubled-up subscriptions, price rises, card interest and idle cash, and tracks what you save, including services you replace with self-hosted alternatives.

## Quick start

You need Docker on any amd64 or arm64 machine.

```sh
mkdir -p muny/data && cd muny
umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
docker run -d --name muny --restart unless-stopped --user "$(id -u):$(id -g)" \
  -p 8420:8420 --env-file .env -v "$PWD/data:/data" ghcr.io/mikedmor/muny:1
```

Open **http://localhost:8420** and create your account.

> [!TIP]
> Want to look around first? Add `-e MUNY_DEMO=true` and Muny starts with a made-up household: six months of transactions, bills, budgets, a loan and more. **Settings → Data → Start clean** removes it when you're ready.

> [!IMPORTANT]
> Keep a copy of `.env` somewhere safe, such as a password manager. `MUNY_SECRET_KEY` encrypts bank connections and stored keys, and without it you'd have to set them up again.

For Docker Compose, Synology, Unraid and every setting, see the **[install guide](guides/install.md)**. Then read **[getting started](guides/getting-started.md)** for a tour of your first hour.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Everyday money

- **Accounts** from bank sync (Plaid or Teller, with your own keys), PayPal, or files
- **Import anything:** Rocket Money exports, bank CSV/OFX/QFX/QBO, PDF statements, brokerage and Koinly exports, all from one page
- **Email import** for accounts that can't sync: card alerts become transactions, and statement emails and PDFs update the card
- **Transactions** with search, filters, splits, notes, tags, merchant cleanup and bulk edits
- **Rules** that file, rename, tag or hide transactions as they arrive
- **Recurring bills and subscriptions** found automatically, with what's due, what's paid and price rises
- **Budgets** by category with rollover, alerts and a month-end forecast, including what's left if every budget gets used
- **Undo for anything:** every change from the last 60 days, by you, your household or an assistant, can be undone or redone

</td>
<td width="50%" valign="top">

### Debts and wealth

- **Loans** with payoff dates, payoff plans and statement reading, including multi-loan student loan servicers
- **Credit cards** with limits, statements, due dates and interest
- **Savings** accounts with interest, earned rate and projections
- **Stocks** from Plaid or broker exports, with cost basis and history, a watch list, and a page for each stock with optional live details and news
- **Crypto** wallets and exchanges, with cost basis, gains and tax reports
- **Assets** such as a home or car, for equity and net worth

</td>
</tr>
<tr>
<td valign="top">

### Insights

- **A customizable Overview**, arranged per screen size, with a card editor that calculates over all your data
- **Spending and reports:** by category and merchant, month over month, income versus spending, net worth over time
- **Ways to save:** doubled-up subscriptions, price rises, self-hosted replacements, card interest, loan order and idle cash
- **Taxes:** yearly totals and an export for your accountant
- **Documents:** statements, contracts and receipts in folders of your own, stored encrypted

</td>
<td valign="top">

### AI and automation

- **MCP server and REST API** with per-token permissions and an activity log
- **Approval inbox:** assistants suggest changes; you approve or reject
- **Optional built-in AI** (off by default), with Claude, an OpenAI-compatible server or Ollama: ask about your money in plain words, have a loan contract reviewed, plus category suggestions, tidier merchant names, a monthly review and a mid-month check-in
- **Alerts** in the app, by phone push, ntfy, Apprise, email or webhook
- **Themes:** light, dark and your own, with a live preview

</td>
</tr>
</table>

## Screenshots

### Day to day

| Transactions                                                                                                                  | Recurring bills and subscriptions                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ![Transactions from every account in one list, with search and filters](guides/images/transactions.png)                       | ![Recurring: subscriptions and bills with what's due and what's been paid](guides/images/recurring.png) |
| **Budgets**                                                                                                                   | **Spending**                                                                                            |
| ![Budgets: Earnings, Home & utilities, Bills & subscriptions and each category against its budget](guides/images/budgets.png) | ![Spending: this month by category and merchant, against recent months](guides/images/spending.png)     |

### What you owe

| Credit cards                                                                                | Loans                                                                                                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ![Credit cards: balance, limit, payoff and recent payments](guides/images/credit-cards.png) | ![Loans: what you owe, the payoff date and each payment split into principal and interest](guides/images/loans.png) |

### What you own

| Savings                                                                                       | Ways to save                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Savings accounts: balance, interest earned and monthly deposits](guides/images/savings.png) | ![Ways to save: duplicate subscriptions, price rises, self-hosted replacements and more, ranked by yearly saving](guides/images/ways-to-save.png) |
| **Stocks**                                                                                    | **Crypto**                                                                                                                                        |
| ![Stocks: portfolio value, gains, allocation and holdings](guides/images/stocks.png)          | ![Crypto: total value over time, what went in, and allocation by coin](guides/images/crypto.png)                                                  |
| **Assets**                                                                                    | **Net worth**                                                                                                                                     |
| ![Assets: a home and a car, with value, equity and history](guides/images/assets.png)         | ![Reports: net worth over time and by account type](guides/images/reports.png)                                                                    |

### Paperwork

| Taxes                                                                                                     | Documents                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ![Taxes: deductible spending, mortgage interest and crypto reports for the year](guides/images/taxes.png) | ![Documents: statements, tax forms and your own files in folders](guides/images/documents.png) |
| **Import anything**                                                                                       | **Accounts**                                                                                   |
| ![Import: drop in any file, or choose what you are bringing in](guides/images/import.png)                 | ![Accounts: every account grouped by type, with net worth](guides/images/accounts.png)         |

### Automation and AI

| Rules                                                                                                          | Approval inbox                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ![Rules: what each rule looks for, what it does and how many transactions it matches](guides/images/rules.png) | ![The inbox: suggested changes wait for you to approve or reject them](guides/images/inbox.png) |
| **AI assistants over MCP**                                                                                     | **Built-in AI (optional)**                                                                      |
| ![AI assistants: each token only reaches the permissions you tick](guides/images/agents.png)                   | ![Built-in AI settings: choose a provider and what it can help with](guides/images/ai.png)      |

### Make it yours

| Customize your Overview                                                                                       | Themes                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ![Customizing the Overview: choose cards, set their priority and build your own](guides/images/customize.png) | ![Appearance: built-in themes and your own](guides/images/appearance.png) |
| **Dark mode**                                                                                                 | **Budgets in dark mode**                                                  |
| ![The Overview in dark mode](guides/images/overview-dark.png)                                                 | ![Budgets in dark mode](guides/images/budgets-dark.png)                   |

### On your phone

<p align="center">
  <img src="guides/images/overview-phone.png" alt="The Overview on a phone" width="260" />
  <img src="guides/images/recurring-phone.png" alt="Recurring charges on a phone" width="260" />
  <img src="guides/images/budgets-phone.png" alt="Budgets on a phone" width="260" />
</p>

Every screenshot uses a made-up household: the built-in demo, plus sample stocks, crypto, assets and documents added for these pictures. All names and numbers are invented.

## Documentation

The full documentation lives in **[guides/](guides/README.md)**.

| Set up                                       | Use                                                                                    | Go further                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Install](guides/install.md)                 | [Transactions and categories](guides/transactions.md)                                  | [AI assistants (MCP)](guides/agents.md)              |
| [Getting started](guides/getting-started.md) | [Recurring bills and subscriptions](guides/recurring.md)                               | [Built-in AI](guides/ai.md)                          |
| [Secure access and HTTPS](guides/access.md)  | [Budgets](guides/budgets.md)                                                           | [Your Overview and custom cards](guides/overview.md) |
| [Bank sync](guides/bank-sync.md)             | [Spending, reports and taxes](guides/reports.md)                                       | [Rules and documents](guides/rules-and-documents.md) |
| [Importing files](guides/importing.md)       | [Loans](guides/loans.md) · [Credit cards](guides/cards.md)                             | [Alerts and notifications](guides/alerts.md)         |
| [Backups and export](guides/backups.md)      | [Savings](guides/savings.md) · [Stocks](guides/stocks.md) · [Crypto](guides/crypto.md) | [Themes](guides/themes.md)                           |
| [Troubleshooting](guides/troubleshooting.md) |                                                                                        |                                                      |

## Privacy and security

- **Self-hosted and private by design.** Muny is meant for your home network or a VPN such as Tailscale, never the open internet. See [secure access](guides/access.md).
- **Nothing leaves without your say.** Bank sync, prices, notifications and AI are each off until you set them up, and every outbound call is documented in the guide for its feature.
- **Encrypted secrets.** Bank tokens, API keys and documents are encrypted at rest (AES-256-GCM) with your `MUNY_SECRET_KEY`.
- **Least privilege for AI.** Assistants see only what their token allows, can't move money, and can't change financial data without your approval.

Read [SECURITY.md](SECURITY.md) for the full model and how to report a vulnerability.

## Built with

TypeScript throughout: [Fastify](https://fastify.dev) and [SQLite](https://sqlite.org) (via [Drizzle](https://orm.drizzle.team)) on the server, [React](https://react.dev), [TanStack](https://tanstack.com) and [Tailwind CSS](https://tailwindcss.com) in the browser, and the [Model Context Protocol](https://modelcontextprotocol.io) SDK for assistants. Money is always integer cents, never floating point.

## Contributing

Bug reports, ideas and pull requests are welcome. Easy places to start are adding services to the self-hosted alternatives catalog and CSV presets for your bank. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, conventions and release process.

## Support the project

Muny is free and open source, built and maintained in spare time. If it saves you a subscription or two, consider passing some of that on:

<p align="center">
  <a href="https://www.paypal.com/donate/?hosted_button_id=79GR7CV7MKETG"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate with PayPal" /></a>
</p>

You'll also find **Support development** at the bottom of the menu inside Muny. Stars, bug reports and sharing Muny with friends help too.

## License

Muny is licensed under the [GNU Affero General Public License v3.0](LICENSE). You're free to use, modify and self-host it. If you run a modified version as a network service for other people, you must make your source code available to them.
