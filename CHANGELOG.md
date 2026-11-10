# Changelog

All notable changes to Muny are listed here. Versions follow [Semantic Versioning](https://semver.org/): a major version can need you to do something when you upgrade, minor versions add features, and patches fix things. Database migrations always run on their own when Muny starts.

## [Unreleased]

### Added

- **Your own document folders.** **New folder** in Documents makes one, empty or not, and **Upload** now goes to whichever folder you're in.
- **Contract review.** Add a loan's contract under **Documents** and have your AI model read it for ways out, ways to save, terms to watch and anything that looks off. Every clause it quotes is checked against the contract's own text and linked to its page. Off by default, under **Settings → AI**.
- Budgets show what would be left over if every budget gets fully used, beside the projection from bills alone.
- A **Muny AI** Overview card with quick questions and your latest review, available while AI is on.
- **Ask Muny**: ask about your money in plain words, answered from read-only lookups of your own data. Off by default, under **Settings → AI**.
- Built-in AI can tidy merchant names (one inbox item to approve) and write a mid-month check-in on how budgets are pacing.
- Built-in AI can suggest categories by itself after a sync or import, offers a rule once you've approved a merchant into a category three times, and suggests a budget from the monthly review. You can choose a model per job, and past reviews are kept in **Reports → Reviews**.
- **Undo for anything.** After a change, an **Undo** bar appears at the bottom of the page (or press Ctrl+Z), and **Settings → History** lists every change from the last 60 days, by you, your household or an assistant, to undo or redo. Muny asks first when something was changed since, or when undoing would remove more than the change added.
- **Remove old agent tokens.** A revoked or expired token can now be taken off the Agents page for good. Its past activity stays in the audit log.
- **Anticipated spending.** The Spent this month chart continues your spending to the end of the month, rising on the due date of each recurring bill still to come. Hover over a day to see its transactions, or what's expected on it.

- **See where a transaction came from.** Its window now shows the source: your bank sync provider, a statement upload, a file import or added by hand.

- **Know when an API runs out.** A new alert tells you when a service reaches its daily or monthly limit. Anything that relies on it, like syncing a wallet or updating prices, is turned off with a note saying how long until it resets.

### Changed

- Large charge alerts say how the charge compares with what's usual at that merchant, and price increase alerts give the percentage.
- Built-in AI with Ollama or an OpenAI-compatible server handles a busy server: it waits out a model download, a queue, or a computer that failed partway, and says how long to wait when you're the one waiting. If the monthly review can't be written, you're told why once, and Muny keeps trying through the 7th.
- **Settings → API** is the one place for every outside service: crypto prices, Blockscout, wallet servers, home and vehicle values and stock extras, each showing whether it's set up and folding away once its key is saved, with request limits for all of them alongside. Crypto's Settings tab keeps cost basis and NFT images, and Assets no longer has a Settings tab.
- **Split totals into colored parts** is now off by default. If you turned it on yourself, it stays on.

### Fixed

- The Spending page's chart highlights the month you're viewing, and follows you when you go back further than it shows.
- The rule editor no longer gets cut off at the bottom on shorter windows.
- The monthly money review shows as a tidy list with its "Next month" step underneath, instead of one run-on paragraph.
- **Copy** buttons (invite links, receive addresses) work when Muny is opened over plain HTTP, such as by its address on your network.
- Closing a window opened from inside a transaction, or choosing a rule under **Rules applied**, no longer closes the transaction as well.

## [1.1.0] - 2026-11-08

Recurring charges and rules work together: a paycheck or bill stays with its series when the bank renames it, and the Rules page shows what needs tidying and fixes it in one click.

### Added

- **Rules can count transactions as recurring.** The new **Count as recurring** action keeps a paycheck or bill in its series even when the bank renames the merchant, so it's never shown as late or counted twice in the month's expected income. **Add a rule for this** on any recurring series opens the rule editor already filled in.
- **Every confirmed recurring series gets a rule of its own.** Muny adds **Count as recurring** to a rule you already have for that series, or creates one for it when none exists. Automatic changes are audited, and deleting or undoing one is remembered.
- **A tidier Rules page.** Your own rules first, with rules for recurring charges in their own section; search, "Made by Muny" on automatic rules, how many transactions each rule matches, and readable When / Then. Rules that do one job between them can be combined in one click, after a check that nothing would be filed differently. One rule can count transactions toward several recurring series, each going to the series on its own account, so a paycheck split across accounts needs one rule.

### Fixed

- A paycheck renamed by the bank no longer shows as late, or counts twice in the month’s expected income.
- A series held by a rule keeps the price of its newest charges, instead of one from years ago, and a price change no longer leaves an empty duplicate behind.
- Muny’s rules for two series with the same name (a paycheck and a small deposit, two loans with one servicer) say which is which, by account or amount, and keep them apart.
- Opening a recurring charge no longer offers “Add a rule” for a moment before showing the rule it already has.

## [1.0.0] - 2026-11-07

The first stable release. Muny covers what Rocket Money does for budgeting and subscriptions, runs in one container on your own hardware, and lets AI assistants work with your data under permissions you set.

Install it with `docker pull ghcr.io/mikedmor/muny:1` and follow the [install guide](https://github.com/mikedmor/muny/blob/main/guides/install.md), or try it first with `MUNY_DEMO=true`.

### Accounts and transactions

- Bank sync through your own Plaid or Teller keys (and PayPal), on a schedule, plus manual accounts.
- **Import takes any file:** drop Rocket Money exports, bank CSV/OFX/QFX/QBO files, PDF statements, brokerage and Koinly exports, or photos on one page, and Muny works out which importer each belongs to. Duplicates are always skipped.
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
- A notice to reload when Muny was updated while a tab was open.

### Documentation

- A full set of [guides](https://github.com/mikedmor/muny/blob/main/guides/README.md): install (Docker, Compose, Synology, Unraid), getting started, every feature, backups and troubleshooting.

If Muny saves you a subscription or two, you can [support its development](https://www.paypal.com/paypalme/mikedmor).

[Unreleased]: https://github.com/mikedmor/muny/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mikedmor/muny/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mikedmor/muny/releases/tag/v1.0.0
