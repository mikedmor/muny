# Credit cards

**Credit cards** (under Money) shows each card: what you owe against its limit, the last statement (balance, minimum payment, due date), the purchase rate, payments, spending since the statement, interest charged this year, and how long paying it off takes at the minimum versus more.

## Getting the details in

- **Bank connection (Plaid):** synced cards bring their credit limit, and when the login shares loan and card details, the statement balance, minimum payment, due date and APR too. For an older connection, use **Get details from your lender** on a loan from the same login, or reconnect.
- **Statement PDFs:** click **Import statements** and choose one or more statements. US card statements all use the same labels, so Muny reads the new balance, minimum payment, payment due date, credit limit and purchase APR from most issuers, and picks the card by the last 4 digits printed on it. The newest statement sets the card's figures; older ones fill in the balance history. Each PDF is kept under Insights → Documents.
- **By hand:** **Edit details** on a card.

Transactions come from the bank connection, or from your issuer's CSV or OFX export (see [Importing files](importing.md)).

## Reading a card

- **Limit used** under 30% is good for your credit score; above 50% is high.
- Paying the **statement balance** by the due date avoids interest on purchases. Muny says so once a payment of at least that much arrives after the statement.
- **Paying it off** shows how long the balance lasts at the minimum payment, and what paying more each month saves.
