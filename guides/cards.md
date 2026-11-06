# Credit cards

**Credit cards** (under Money) shows each card: what you owe against its limit, the last statement (balance, minimum payment, due date), the purchase rate, payments, spending since the statement, interest charged this year, and how long paying it off takes at the minimum versus more.

## Getting the details in

- **Bank connection (Plaid):** synced cards bring their credit limit, and when the login shares loan and card details, the statement balance, minimum payment, due date and APR too. For an older connection, use **Get details from your lender** on a loan from the same login, or reconnect.
- **Statement PDFs:** **Import statements** (or **Upload statement** on a card) reads one or more statements: the new balance, minimum payment, payment due date, credit limit, purchase APR, the year's interest so far, and the bank's own "minimum payment only" estimate. Most US issuers work (the labels are required by law); Muny picks the card by the last 4 digits printed on it. The newest statement sets the card's figures; older ones fill in the balance history. The transactions listed on a statement (purchases, payments, interest, fees) can be added to the card too, skipping ones already in Muny. Each PDF is kept under Insights → Documents.
- **Linking payments:** if the card's own transactions don't include your payments, click **Link payments** and type the words your payments use in checking (as they appear there). Those payments show on the card.
- **By hand:** **Edit details** on a card.

Transactions come from the bank connection, its statements, or your issuer's CSV or OFX/QFX download (see [Importing files](importing.md)). There's no free way to connect a card directly through Visa, Mastercard or Discover: the networks don't offer an API for your own accounts; your card's bank holds the data. Free routes are Plaid (Trial plan) and Teller (free development tier) when they support your bank, statements, and your bank's downloads.

## Reading a card

- **Limit used** under 30% is good for your credit score; above 50% is high.
- Paying the **statement balance** by the due date avoids interest on purchases. Muny says so once a payment of at least that much arrives after the statement.
- **Paying it off** shows how long the balance lasts at the minimum (which shrinks with the balance, as banks figure it, with your statement's own estimate beside it), and what paying more each month saves.
