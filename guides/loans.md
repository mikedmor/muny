# Loans and assets

**Loans** (under Money) shows every loan account: what you owe, the rate, your payment and the minimum, the next due date, when it'll be paid off and how much interest is left. **Assets** (under Wealth) holds your home, car and other things of value, so loans can show your equity.

## Getting your loans in

- **Through your bank connection.** Synced loans keep the balance the lender reports. Connections made from now on also bring the rate, minimum payment, due date and original amount when the lender shares them. For an older connection, click **Get details from your lender** on the loan: Plaid asks you to approve sharing loan details on the same login (no new login is used). Or enter them yourself with **Edit details**.
- **Tracked from your payments.** For lenders bank sync can't reach, click **Add a loan** and enter what you owe on a date (from a recent statement), the rate, and the words your payments use in checking, for example `SEAVIEW RESORTS`. Muny finds every payment containing those words, takes out the interest that built up since the last payment, and lowers the balance by the rest.

### Several loans with one lender

Loans with the same lender share one card on the Loans page, with a tab for each loan.

- **Paid separately, each with its own amount** (for example three timeshare loans plus yearly dues, all under one name): give each loan the same payment words, its own **Only payments of about** amount and its **Next payment due** date. Muny counts payments made within about a week of each loan's due day, and when a payment could belong to two loans it goes to the closest match. Payments of other amounts, such as the dues, aren't counted toward any of them.
- **A yearly fee** (timeshare maintenance, dues) belongs to the lender, not to one loan. On the lender's card click **Add a yearly fee** (a lone loan has a **Yearly fee** link next to **Edit details**). Enter the smallest it's likely to be (for example 2,200.00), the words in the fee payments if they differ from the loans' words, and the next due date if you know it. The card shows the last fee, the next one (your due date, else a year after the last), and how much to set aside each month. Fee payments are never counted toward the lender's loans, and the amount can change from year to year.
- **When a payment changes:** enter the new amount in **Only payments of about**. Muny keeps counting earlier payments of the old amount, so the history stays with the loan; the old amounts are listed under the field, where you can remove one.
- **Payments that each cover several loans** (student loans in groups, say AA to AE, paid by two scheduled payments that each apply to some of them): click **Add a loan**, then **Several from one lender**. Enter the lender, the words your payments use, and each loan with what you owe and its rate. Under **How you pay them**, add one entry per scheduled payment: its day of the month, and what it puts toward each loan (your servicer's payment details show the total applied to each loan). Muny finds each payment by its words, its total and the day, and splits it by those amounts. For loans you've already added, use **Set up payments that cover several of these loans** (or **Payments → Edit**) on the lender's card. Enter what each payment applied to each loan in total (principal and interest together); Muny works out the interest itself.

  If the servicer changes how it splits a payment (a loan stops getting a share, say), open **Payments → Edit** and click **Split changed** on that payment. The old split keeps the payments before the date, and you change the copy from the date it changed (adjust **From** and **Until** if needed).
- **One payment covering several loans, split by monthly payment** (common with student loans): give each loan the same payment words and no amount, plus its own monthly payment. Each payment is shared between them in proportion to their monthly payments.

### Student loan statements

Federal student loan servicers send PDF statements with a table for each loan group. On the lender's card, click **Import statements** and choose one or more PDFs, from any months. Muny lists each statement it read and, for each group, its rate, what you owe, the regular payment and the due date, with the loan it belongs to; pick another loan, **Add as a new loan** or **Skip**, then update.

- Statements are applied oldest first. Each one records exactly what the servicer applied to each group since the previous statement (interest and principal, including a group that got nothing) and what you owed that day, so importing this year's statements makes the payment history and balance history exact.
- Only the newest statement sets a loan's balance, rate, payment and due date; the loan counts on from its date. Payments after it are found in your bank and split as set under **Payments** until the next statement.
- If you get more than one statement a month (one per due date), import them all.
- Each PDF is kept under **Insights → Documents**.
- **Split like your servicer:** once a lender has statements, Muny splits its later payments the way federal servicers do: first what's currently due on each loan (in proportion to its regular payment), then the rest to the loans with the highest rate, by balance. A loan paid ahead (its due date months away, marked **Paid ahead**) gets nothing until it's due again. You can switch back to **set amounts** on the lender's card.
- **Statements** on the lender's card shows the newest statement for each billing cycle and when the next is due, and says when one is missing.

Any loan's **Edit details**, and each payment in a lender's **Payments**, can also be limited to payments **paid from** one account, for when the same words show up from more than one account.

## Reading a loan

- **Payment** shows your usual payment; **Minimum** is the lowest payment due (from the lender, or entered).
- For a **mortgage** with its original amount, rate and term entered, Muny works out the principal and interest part of the payment; the rest is escrow (taxes and insurance). Payoff dates use the principal and interest part.
- **Payments** lists each payment, the account it came from, and its split into interest and principal. For synced loans the split is worked back from today's balance, so it's an estimate. For loans tracked from your payments, payments before the **As of** date are listed with an estimated split worked back from what you owed then; only later payments lower the balance.
- **Payoff** charts your balance after each payment so far (solid), then down to zero (dashed). Drag **Pay extra each month** to see how much sooner it ends and how much interest you'd save.

## Payoff plan

The **Payoff plan** tab helps you pay your loans off sooner. Every loan keeps its payment; extra money you add, and the payments of loans you finish, go to the loans in your chosen order. It's a plan only: Muny never pays anything.

- **Your goal:** **Highest rate first** pays the least interest; **Smallest balance first** clears loans one by one for quick wins; **My own order** lets you arrange them with the arrows.
- **Extra each month:** what you can add on top of your payments.
- **Pay only the minimum on the others:** whatever you pay above the minimums goes to the first loan instead.
- **Debt-free by** and **Goal: paid off by** (per loan): Muny tells you how much extra or how much a month it would take.

You see when you'd be debt-free, the interest left and what you'd save compared with paying as you do now, a chart of each loan's balance, and suggestions (a better order, moving payments, the extra needed for your dates) you can apply with one click. Mortgages are left out unless you add them. Your choices are saved.

## Mortgage insurance

Enter the home's **original value** (the lower of the purchase price and the original appraisal) and the monthly mortgage insurance. Muny shows your equity on that value, when you reach 20% (you can ask your lender to cancel it) and 22% (it ends on its own), at your current payments.

## Assets and equity

On **Assets**, add your home with what it's worth now and what you paid. Update the value now and then (a home value site's estimate is fine); each update is kept, so you see its value over time, and it counts toward net worth. In the mortgage's **Edit details**, pick it as **The home** to see your equity and loan-to-value on both pages.

For an asset with no loan linked (a car you own outright, say), set **Owed on it** yourself, or click **Paid off**.

## Automatic values (optional)

On **Assets → Settings**, add your own keys:

- **Homes: APillow** (Zillow data, free plan 50 lookups a month, [apillow.co](https://apillow.co)). Give the home its address as Zillow shows it. **Look up value** fills in Zillow's estimate, plus beds, baths, square feet, lot, year built, last sale, property tax and the rent estimate. Zillow has no estimate for homes listed for sale; Muny says so and keeps your value.
- **Vehicles: CarAPI.dev** (free plan 100 requests a month, [carapi.dev](https://carapi.dev)). Give the vehicle its year, make, model and mileage (the make and model fields suggest names from NHTSA's public vehicle database, which only sees the make and year you type); **Look up value** fills in its US market value.

**Request limits** on the same tab shows each service's use today and this month, and Muny stops before its own cap, under each free plan. APillow counts different homes per day (up to 45; looking the same home up again that day doesn't count) and every request separately; CarAPI stops at 95 lookups a month.

After the first lookup, values over a month old are looked up again when you open Assets. Typing a value yourself takes over until you look it up again. Keys are stored encrypted and sent only to their service, which sees only the address (homes) or the year, make, model and mileage (vehicles).

## Payments and spending

A payment from checking to a loan counts as spending under its category (for example "Loan Payment"). When the loan account is also connected, the money arriving there is matched to that payment as a transfer, and the loan's own entries (interest it charges, payments it receives) aren't counted again as spending, bills or income.
