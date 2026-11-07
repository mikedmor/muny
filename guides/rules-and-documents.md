# Rules and documents

## Rules

A rule finds transactions and does something to them: sets the category, renames the merchant, adds a tag, or ignores them everywhere (left out of totals and reports). New transactions always run your rules.

- **From a transaction:** open it. If no rule applies yet, click **Add rule** (+). If rules apply, **Rules** (→) lists them, with how many transactions each matches; click one to change it, or **Add rule** for another.
- **After changing a category:** a note appears at the bottom right, "Changed category to …". Click **+ Rule** to make a rule for transactions like it, already filled in.
- **Create a rule** works in two steps. First, how it finds transactions: by name (bank description or merchant name: contains, is, starts with, ends with), amount, money in or out, and account. The matching transactions are listed as you go. **Continue**, then choose what it does, name it, and whether to change the transactions it already matches (optionally including ones you changed by hand).

All rules, their order and the full editor (several names, "any of") are in **Settings → Rules**.

While you make or edit a rule, Muny warns when you already have the same rule, or another rule matches the same transactions (saying how many, and whether it files them differently), with **Edit this rule instead** to change the one you have. When rules disagree, the one higher in the list wins.

After you change a transaction's category (on Transactions or a category page, including a pending charge there), **+ Rule** offers to do the same for transactions like it.

## Documents

**Insights → Documents** keeps your files in folders by where they come from:

- **Loans / lender** and **Credit cards / card:** statements you import, filed automatically.
- **Statements / account:** statements for other accounts (checking, savings…), kept with their date.
- **Taxes / year:** 1099-DA forms you added on the Taxes page, and the reports Muny makes for that year (the tax summary CSV and the crypto tax reports), made fresh when you open them.
- **Your own folders:** **Upload** puts files (PDF, PNG or JPEG, up to 10 MB) in the folder you've picked on the left, or **Uploads**. Move a file with the folder button; type a new name like `Home / Insurance` to make a folder.

Search by name, lender, year or folder; open, download or delete. Files are stored in Muny's database, so backups include them, and they're encrypted with `MUNY_SECRET_KEY` when it's set. The same file is only kept once.

## Statements

**Import statements** on Accounts (and on Credit cards and Loans), or the upload button on an account's row, takes one or more statement PDFs for any account. For each one Muny suggests what it is (a card or loan statement, or one it can't read) and the account, by the last 4 digits printed on it. For each statement you can:

- **Read it into the account:** card and loan statements set the balance, minimum or payment, due date and rate, as on the [Credit cards](cards.md) and [Loans](loans.md) pages. Use **Teach Muny** when a value is missing.
- **Just keep it:** store it under Documents for that account without reading it. Give the statement date (Muny suggests one when it can find it).
- **New account…:** make the account from the statement (name and type; the last 4 digits come from the statement).

Each account then shows its **last statement** date, and how many monthly statements are missing (between your first statement and now), so you can see which ones to download. A student loan statement covering several loans is read with **Import statements** on the lender's card on Loans.
