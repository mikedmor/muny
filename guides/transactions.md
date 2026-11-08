# Transactions and categories

**Transactions** (under Money) lists everything from every account, newest first. It's where you search, fix categories, split purchases and add notes.

## Finding things

- **Search** matches the merchant, notes or an amount (type `42.10` to find that charge).
- **Filters** narrow the list by account, category (including **Uncategorized**), tag and date range.
- **Hidden transactions** are left out unless you choose **Including hidden** or **Hidden only**.

## Working with one transaction

Click a transaction to open its details:

| Action                 | What it does                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Category**           | Files it. A note then offers **+ Rule** to do the same for similar transactions automatically.                                                                                          |
| **Merchant name**      | Renames the merchant. The new name shows instead of the bank's description, and later charges with a similar description get it too.                                                    |
| **Notes** and **tags** | Your own text and labels, for example `#reimbursable` or `#tax-deductible`. Tags can be filtered, and `#tax-deductible` collects the transaction on the [Taxes](reports.md#taxes) page. |
| **Split**              | Divides one purchase across several categories (a store run that was half groceries, half household). Muny shows how much is left to allocate until it adds up.                         |
| **Repeats**            | Tells Muny this is a recurring charge or income, with how often it repeats. See [Recurring](recurring.md).                                                                              |
| **Hide**               | Leaves it out of every total and report, while keeping it on record. Best for duplicates and transfers your bank reports twice.                                                         |
| **Delete**             | Removes it permanently, after you confirm. For bank-synced transactions, hiding is usually better, since the bank may send it again.                                                    |
| **Rules**              | Lists the rules that apply to it, or **Add rule** to make one from it.                                                                                                                  |

## Changing many at once

Tick the transactions you want, then **Set category…** or **Add tag** to change them all together.

## Adding a transaction by hand

**Add transaction** records cash spending, a check, or anything that isn't in a file: the account, date, description, amount (negative for spending) and category.

## Categories

Muny starts with a set of categories in groups (Income, Housing & Utilities, Food & Dining, Transportation and so on), which you can change completely under **Settings → Categories**:

- Rename, move between groups, hide, or create new ones. Any category picker also lets you type a new name and **+ Create** it on the spot.
- Mark categories as **Home** (Home & utilities) or **Bill** (Bills & subscriptions) for the [budget basics](budgets.md#budget-basics), or leave them out of budgets entirely.
- Delete a category, choosing where its transactions, rules and budget move.

The full list of category options is in [Budgets → Managing categories](budgets.md#managing-categories).

## How Muny reads bank descriptions

Banks write descriptions like `POS DEBIT WD7 FT. WORTH TX`. Muny drops card prefixes, store numbers, dates, phone numbers and locations to name the merchant (**WD7**), and recognises later charges from the same place even when the numbers change. Transfers between your own accounts (a card payment from checking, a move to savings) are matched up and never count as spending or income.

## Related

- [Rules](rules-and-documents.md#rules): file transactions automatically.
- [Importing files](importing.md): bring transactions in from your bank or Rocket Money.
- [Budgets](budgets.md): how categories add up.

---

[← All guides](README.md)
