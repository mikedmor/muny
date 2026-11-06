# Rules and documents

## Rules

A rule finds transactions and does something to them: sets the category, renames the merchant, adds a tag, or ignores them everywhere (left out of totals and reports). New transactions always run your rules.

- **From a transaction:** open it. If no rule applies yet, click **Add rule** (+). If rules apply, **Rules** (→) lists them, with how many transactions each matches; click one to change it, or **Add rule** for another.
- **After changing a category:** a note appears at the bottom right, "Changed category to …". Click **+ Rule** to make a rule for transactions like it, already filled in.
- **Create a rule** works in two steps. First, how it finds transactions: by name (bank description or merchant name: contains, is, starts with, ends with), amount, money in or out, and account. The matching transactions are listed as you go. **Continue**, then choose what it does, name it, and whether to change the transactions it already matches (optionally including ones you changed by hand).

All rules, their order and the full editor (several names, "any of") are in **Settings → Rules**.

## Documents

**Insights → Documents** keeps your files: loan statements you import on the Loans page are saved there automatically, and **Upload** adds your own PDF, PNG or JPEG files (titles, tax forms, receipts), up to 10 MB each. Search by name, lender or date; open, download or delete.

Files are stored in Muny's database, so backups include them, and they're encrypted with `MUNY_SECRET_KEY` when it's set. The same file is only kept once.
