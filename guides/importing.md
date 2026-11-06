# Importing files

Everything in Muny can come from files you export yourself. Importing the same file twice never duplicates anything: rows already in Muny are recognised and skipped.

## Bank accounts and transactions

**Import** (in the account menu at the bottom of the sidebar) takes:

- **Rocket Money** transaction exports (CSV). Accounts, categories and merchants come along.
- **OFX, QFX and QBO** files from your bank's download page.
- **Bank CSV** exports. Common layouts (Chase and others) are recognised automatically; for anything else you pick which column is the date, description and amount.

Muny shows a preview first: which accounts it found, how many transactions are new, and which ones it already has. Accounts are matched to existing ones by the last digits of the account number when the file has them.

## Brokerage accounts

On **Stocks → Import**, add your broker's CSV exports. See [Stocks](stocks.md) for where to find them.

## Crypto

On **Crypto → Wallets → Import file**, add Koinly's **Transaction History** CSV (once per year you have). See [Crypto](crypto.md).
