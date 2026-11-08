# Getting started

A tour of your first hour with Muny, from an empty install to a working budget. If Muny isn't running yet, start with [Install](install.md).

> [!TIP]
> Not ready to add your own data? Start Muny with `MUNY_DEMO=true` to explore a made-up household first. **Settings → Data → Start clean** removes it whenever you like, keeping your login and settings.

## 1. Create your account

Open Muny in your browser (for example `http://your-server:8420`). The first visit creates the **owner** account, the one that manages the household, backups and AI access. Use a strong password: the only way to recover a lost one is to restore a backup.

You can invite other people later under **Settings → Household & account**, as full members or view-only.

## 2. Bring in your accounts

Pick whichever fits, or mix them:

| Way                                     | Best for                                                              | Guide                                       |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| **Rocket Money export**                 | Moving over with years of history, categories and merchants in one go | [Importing files](importing.md)             |
| **Bank sync** (Plaid, Teller, PayPal)   | Keeping accounts up to date automatically                             | [Bank sync](bank-sync.md)                   |
| **Bank downloads** (CSV, OFX, QFX, QBO) | Banks that sync doesn't reach, or no sync at all                      | [Importing files](importing.md)             |
| **Statements** (PDF)                    | Credit cards and loans: balances, due dates and rates                 | [Credit cards](cards.md), [Loans](loans.md) |
| **By hand**                             | Cash, or anything without a file                                      | [Transactions](transactions.md)             |

Everything goes through **Import** (in the menu under your name at the bottom of the sidebar): drop any file there and Muny works out what it is. Importing the same file twice never creates duplicates.

After an import, open **Accounts** and check each balance matches your bank. Accounts made from a file start from a zero opening balance until you set it.

## 3. Tidy up categories

Muny categorizes transactions as they arrive. Open **Transactions**, filter to **Uncategorized**, and fix what's left. Each time you change a category, Muny offers **+ Rule** so similar transactions file themselves from then on. See [Transactions and categories](transactions.md) and [Rules](rules-and-documents.md#rules).

## 4. Review your recurring bills

Open **Recurring**. Muny has looked for charges and income that repeat, and lists each with its schedule and amount. **Confirm** the real ones and mark the rest **Not recurring**. From then on you'll see what's due, what's paid, and price rises. See [Recurring](recurring.md).

## 5. Set a budget

Open **Budgets** and click a category's **Budgeted** amount to set it. The **Budget basics** at the top add up for you: earnings, home and utilities, bills and subscriptions, and everything else. See [Budgets](budgets.md).

## 6. Make it yours

- **Overview:** **Customize** chooses and orders your cards, for each screen size. See [Your Overview](overview.md).
- **Alerts:** bills coming due, low balances, unusual charges and budgets, in the app or on your phone. See [Alerts](alerts.md).
- **Theme:** light, dark or your own colors under **Settings → Appearance**. See [Themes](themes.md).

## 7. Keep it safe

- Reach Muny privately from anywhere, with HTTPS, through Tailscale: [Secure access](access.md).
- Muny backs itself up every day. Copy its folder somewhere else too: [Backups](backups.md).

## Optional: bring in an assistant

Connect Claude or another AI assistant to ask questions about your money, build Overview cards and suggest changes for you to approve: [AI assistants](agents.md). Muny can also use AI itself for a few jobs, off unless you turn it on: [Built-in AI](ai.md).

---

[← All guides](README.md)
