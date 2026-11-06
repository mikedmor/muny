# Credit cards

**Credit cards** (under Money) shows each card: what you owe against its limit, the last statement (balance, minimum payment, due date), the purchase rate, payments, spending since the statement, interest charged this year, and how long paying it off takes at the minimum versus more.

## Getting the details in

- **Bank connection (Plaid):** synced cards bring their credit limit, and when the login shares loan and card details, the statement balance, minimum payment, due date and APR too. For an older connection, use **Get details from your lender** on a loan from the same login, or reconnect.
- **Statement PDFs:** **Import statements** (or **Upload statement** on a card) reads one or more statements: the new balance, minimum payment, payment due date, credit limit, purchase APR, the year's interest so far, and the bank's own "minimum payment only" estimate. Most US issuers work (the labels are required by law); Muny picks the card by the last 4 digits printed on it. The newest statement sets the card's figures; older ones fill in the balance history. The transactions listed on a statement (purchases, payments, interest, fees) can be added to the card too, skipping ones already in Muny. Each PDF is kept under Insights → Documents.
- **Linking payments:** if the card's own transactions don't include your payments, click **Link payments** and type the words your payments use in checking. Two cards from the same bank often share those words: narrow each down by **about this much** (leave it empty for a card you pay in full each month), **around this day** and **paid from**. A payment that fits both goes to the closer match (an amount counts most, then the paying account, then the day).
- **By hand:** **Edit details** on a card.

Transactions come from the bank connection, its statements, or your issuer's CSV or OFX/QFX download (see [Importing files](importing.md)). There's no free way to connect a card directly through Visa, Mastercard or Discover: the networks don't offer an API for your own accounts; your card's bank holds the data. Free routes are Plaid (Trial plan) and Teller (free development tier) when they support your bank, statements, and your bank's downloads.

### Statements Muny can't read yet

If a statement comes back with the balance, minimum or due date missing, click **Teach Muny** under its name. Pick the line each value is on (Muny lists the statement's lines that have that kind of value), and give text found on every one of these statements, like the bank's web address. Muny keeps it as a template and reads every statement containing that text the same way, including the ones you're importing now. Templates are also available through the API (`/api/statement-templates`), so an assistant can set them up for you.

### Hand-added cards

A card you added by hand counts its balance from what you owed when you added it plus its transactions. Once it has a statement, the newest statement's balance is used instead (plus anything after it), so adding a statement's transactions never counts twice. Payments linked from checking after the newest statement lower what's owed until the next statement includes them.

## Reading a card

- **Limit used** under 30% is good for your credit score; above 50% is high.
- Paying the **statement balance** by the due date avoids interest on purchases. Muny says so once a payment of at least that much arrives after the statement.
- **Paying it off** charts what you've owed (from your statements) and then the balance falling at the amount you pick, and shows how long the balance lasts at the minimum (which shrinks with the balance, as banks figure it, with your statement's own estimate beside it), and what paying more each month saves.
