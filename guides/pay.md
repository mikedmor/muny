# Pay

Your bank only sees take-home pay. **Pay** (under Insights) shows the rest: what you earn before anything comes out, what goes to taxes, what your benefits cost, and where the money landed.

It works from the documents your payroll site gives you:

- **Pay stubs** (earnings statements), as PDFs
- **W-2s**, as PDFs

Muny reads ADP's layout today. If your employer uses a different payroll service, Muny will say it can't read the file; please [open an issue](https://github.com/mikedmor/muny/issues) if you'd like your layout supported.

> [!IMPORTANT]
> Pay stubs and W-2s are stored encrypted, so `MUNY_SECRET_KEY` must be set (see [Install](install.md)). Muny keeps the amounts, the line names (like "Medical" or "Federal Income Tax") and the last 4 digits of each deposit account. Your name, address, Social Security number and full account numbers are never stored outside the encrypted file.

## Adding them

Click **Add pay stubs or W-2s** and pick one or more PDFs (a whole year of weekly stubs at once is fine; you'll see one short summary when it's done). Muny works out which is which. A PDF with several stubs (one per page) is fine, and a stub you've already added is skipped.

**Your latest pay stub is enough to see the year so far**, because its year-to-date column covers every paycheck before it. Add older stubs if you want each deposit checked, and your W-2 when the year is over.

Each stub is checked as it's read: earnings must add up to gross pay, gross pay less taxes and deductions must equal net pay, and the deposits must add up to net pay. If something doesn't add up, the stub is still kept and the page says what's off.

## What you see

- **The year so far**: gross pay, taxes, benefits and deductions, and take-home, with each tax and deduction listed. Items taken out before income tax are marked **pre-tax**. Some stubs leave a deduction's year-to-date amount blank; Muny then adds it up from the stubs you've added and marks it **from your stubs**.
- **Each paycheck**: your latest stub line by line, next to the same amounts for a whole year (52 paychecks if you're paid weekly, 26 every two weeks, and so on).
- **W-2**: its boxes, and a comparison with your last pay stub of that year. With only a W-2 for a year, the page uses it on its own; take-home then still includes deductions taken after tax, since a W-2 doesn't list them.
- **Health coverage**: W-2 box 12, code DD, is the whole cost of your health coverage. Muny splits it into what you paid (the health premiums taken from your pay before tax) and, roughly, what your employer paid, and shows your pay counting that share. It isn't income and isn't taxed. ADP's "Other Cafe 125" line (Section 125 of the tax code) is shown as **Health premiums**.
- **Pay stubs**: each one with where its money was deposited. Muny looks for each deposit in your accounts (same amount, a few days around the pay date, the same last 4 digits when it knows them) and shows the account it arrived in.

Stubs and W-2s also appear on the **Documents** page, and **Taxes** shows a **Wages and withholding** card for the year.

Budgets, Spending and Reports still count the deposits that reach your bank, so nothing is counted twice.

## AI assistants

Assistants with the `read:summary` permission can use `get_pay_summary` for the totals (never the files). Ask Muny can use it too. See [AI assistants](agents.md).

---

[← All guides](README.md)
