# Stocks

**Stocks** (in the menu, under Wealth) tracks your brokerage accounts: what each one holds, its value, your gain over what you paid, cash, and dividends and interest. Brokerage accounts count toward net worth.

Muny doesn't fetch stock quotes. Values and prices are the ones your broker reports, updated whenever you import (or, later, sync). Muny never places trades.

## Importing from your broker

Most brokers offer two exports, and Muny reads both:

- **Positions** (what you hold now): sets each account's holdings, value and cost basis. Import it whenever you want the values brought up to date; each import also adds a point to the "Value over time" chart.
- **Account history** (buys, sales, dividends, transfers): fills in the Activity list and the dividends total.

On **Stocks → Import**, choose the file. Muny shows which broker and accounts it found, and which Muny account each one goes into: an existing one (matched by the last digits of the account number), a new one, or skip. Importing the same file again only adds what's new.

| Broker        | Positions                                                 | History                                                       |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| **Fidelity**  | Accounts & Trade → Portfolio → Positions → Download       | Accounts & Trade → Portfolio → Activity & Orders → Download   |
| **Schwab**    | Accounts → Positions → Export                             | Accounts → History → Export                                   |
| **Vanguard**  | Holdings and transactions download as one CSV file (both) |                                                               |
| **Robinhood** | (not offered)                                             | Account → Reports and statements → Reports → Account activity |
| **Webull**    | (not offered)                                             | Orders → Order history → Export                               |

Other brokers' CSV exports usually work too: Muny finds the header row and recognises columns by their usual names (date, action, symbol, quantity, price, amount). If a file isn't recognised, Muny says so and imports nothing.

Menu names change from time to time. If the path above doesn't match, look for "Download", "Export" or a CSV icon on the positions or history page.

## Reading the page

- **Unrealized gain** uses the cost basis your broker reports. Positions without a reported cost (for example shares transferred in from another broker) are left out of the gain and listed under it.
- **Cash** includes money market and sweep funds (such as Fidelity's SPAXX).
- **Holdings** shows each security across all accounts. Click a row to see how much of it each account holds.

## Coming next

- Automatic sync through Plaid Investments (for example Public.com), using your own Plaid keys.
- Tax lots worked out from your trades: realized gains, dividends on the Taxes page, and a check against your 1099-B.
