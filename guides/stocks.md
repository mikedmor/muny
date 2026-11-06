# Stocks

**Stocks** (in the menu, under Wealth) tracks your brokerage accounts: what each one holds, its value, your gain over what you paid, cash, and dividends and interest. Brokerage accounts count toward net worth.

Muny doesn't fetch stock quotes. Values and prices are the ones your broker reports, updated whenever you import or sync. Muny never places trades.

## Connecting a brokerage through Plaid

If you've set up [Plaid](bank-sync.md), click **Accounts → Connect a brokerage** (or **Connect a brokerage** on the Stocks page). Muny asks Plaid for the brokerage login's investments only, and your holdings, cost basis and up to two years of history then sync along with your banks.

- Plaid's Trial plan includes Investments. Each brokerage login uses one of the plan's logins, like a bank does.
- For brokerages, use **Connect a brokerage**, not **Connect a bank**. A bank connection asks for Transactions, which most brokerages don't offer, so they wouldn't appear in Plaid's list.
- History can take a few minutes to become available after you connect. Holdings show up right away, and history fills in on a later sync.
- Any part of an account's balance that isn't in a holding is shown as cash.

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

## Filling in past values

The "Value over time" chart starts when you first connect or import an account. To see further back, press **Fill in history** under the chart. Muny then:

1. Fetches each ticker's daily closing prices back to your first trade from Yahoo Finance. It sends only ticker symbols, once per ticker; money market funds and options aren't looked up.
2. Works out how many shares and how much cash each account held on every day, starting from what it holds today and undoing each trade (stock splits included).
3. Values each day at that day's close.

These values are estimates and are marked as such under the chart. They're only as complete as your trade history: Plaid provides up to two years, and older trades can be added with your broker's history export. Shares you held before the earliest trade are counted all the way back. From the day an account was first connected or imported, the chart shows the values your broker reported.

Expanding a holding in the Holdings table shows its price history.

## Watch list

The **Watch list** on the Stocks page follows tickers you're interested in, whether you own them or not. Type a ticker (like NVDA) and press **Watch**. Each row shows the latest price with its change over a day, a month and a year, plus a three-month trend. If you also hold that ticker, the row says how much.

Watch list prices come from Yahoo Finance: a year of daily closes when you add a ticker, then an update at most once a day when you open Stocks. Only the ticker symbol is sent.

## What you paid (cost basis)

Gains need to know what you paid. Muny uses, in order:

1. **Your broker's figure**, when it reports one.
2. **Your trades:** if your history includes the buys behind every share you hold, Muny works the cost out (first in, first out, stock splits included).
3. **What you enter:** expand a holding and click **Add cost** next to the account, then type your average cost per share. You can change or clear it later.

Costs that Muny worked out or that you entered are marked with an asterisk.

## Logos and market overview (optional)

Two extras are off until you turn them on, from the banner on the Stocks page or the **Extras** switches at the bottom:

- **Company logos:** Muny's server fetches each ticker's logo once, from Financial Modeling Prep or Parqet, and keeps it. Your browser only ever loads it from Muny.
- **Market overview:** the S&P 500, Nasdaq 100, Dow and Russell 2000 (through the SPY, QQQ, DIA and IWM funds) and the VIX, with a chart for each from one day to one year, plus the Vanguard sector funds' returns over 1 day to 5 years. Prices come from Yahoo Finance, refreshed at most once an hour while you're looking.

Both send only ticker symbols, never your holdings.

## Reading the page

- **Unrealized gain** uses the cost basis your broker reports. Positions without a reported cost (for example shares transferred in from another broker) are left out of the gain and listed under it.
- **Cash** includes money market and sweep funds (such as Fidelity's SPAXX).
- **Holdings** shows each security across all accounts. Click a row to see how much of it each account holds.

## Coming next

- Tax lots worked out from your trades: realized gains, dividends on the Taxes page, and a check against your 1099-B.
