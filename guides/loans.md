# Loans and assets

**Loans** (under Money) shows every loan account: what you owe, the rate, your payment and the minimum, the next due date, when it'll be paid off and how much interest is left. **Assets** (under Wealth) holds your home, car and other things of value, so loans can show your equity.

## Getting your loans in

- **Through your bank connection.** Synced loans keep the balance the lender reports. Connections made from now on also bring the rate, minimum payment, due date and original amount when the lender shares them. For an older connection, click **Get details from your lender** on the loan: Plaid asks you to approve sharing loan details on the same login (no new login is used). Or enter them yourself with **Edit details**.
- **Tracked from your payments.** For lenders bank sync can't reach, click **Add a loan** and enter what you owe on a date (from a recent statement), the rate, and the words your payments use in checking, for example `SEAVIEW RESORTS`. Muny finds every payment containing those words, takes out the interest that built up since the last payment, and lowers the balance by the rest.

### Several loans with one lender

Loans with the same lender share one card on the Loans page, with a tab for each loan.

- **Paid separately, each with its own amount** (for example three timeshare loans plus yearly dues, all under one name): give each loan the same payment words, its own **Only payments of about** amount and its **Next payment due** date. Muny counts payments made within about a week of each loan's due day, and when a payment could belong to two loans it goes to the closest match. Payments of other amounts, such as the dues, aren't counted toward any of them.
- **One payment covering several loans** (common with student loans): give each loan the same payment words and no amount, plus its own monthly payment. Each payment is shared between them in proportion to their monthly payments.

## Reading a loan

- **Payment** shows your usual payment; **Minimum** is the lowest payment due (from the lender, or entered).
- For a **mortgage** with its original amount, rate and term entered, Muny works out the principal and interest part of the payment; the rest is escrow (taxes and insurance). Payoff dates use the principal and interest part.
- **Payments** lists each payment, the account it came from, and its split into interest and principal. For synced loans the split is worked back from today's balance, so it's an estimate.
- **Payoff** charts the balance down to zero. Drag **Pay extra each month** to see how much sooner it ends and how much interest you'd save.

## Mortgage insurance

Enter the home's **original value** (the lower of the purchase price and the original appraisal) and the monthly mortgage insurance. Muny shows your equity on that value, when you reach 20% (you can ask your lender to cancel it) and 22% (it ends on its own), at your current payments.

## Assets and equity

On **Assets**, add your home with what it's worth now and what you paid. Update the value now and then (a home value site's estimate is fine); each update is kept, so you see its value over time, and it counts toward net worth. In the mortgage's **Edit details**, pick it as **The home** to see your equity and loan-to-value on both pages.

For an asset with no loan linked (a car you own outright, say), set **Owed on it** yourself, or click **Paid off**.

## Automatic values (optional)

On **Assets → Settings**, add your own keys:

- **Homes: APillow** (Zillow data, free plan 50 lookups a month, [apillow.co](https://apillow.co)). Give the home its address as Zillow shows it. **Look up value** fills in Zillow's estimate, plus beds, baths, square feet, lot, year built, last sale, property tax and the rent estimate. Zillow has no estimate for homes listed for sale; Muny says so and keeps your value.
- **Vehicles: CarAPI.dev** (free plan 100 requests a month, [carapi.dev](https://carapi.dev)). Give the vehicle its year, make, model and mileage (the make and model fields suggest names from NHTSA's public vehicle database, which only sees the make and year you type); **Look up value** fills in its US market value.

After the first lookup, values over a month old are looked up again when you open Assets. Typing a value yourself takes over until you look it up again. Keys are stored encrypted and sent only to their service, which sees only the address (homes) or the year, make, model and mileage (vehicles).

## Payments and spending

A payment from checking to a loan counts as spending under its category (for example "Loan Payment"). When the loan account is also connected, the money arriving there is matched to that payment as a transfer, and the loan's own entries (interest it charges, payments it receives) aren't counted again as spending, bills or income.
