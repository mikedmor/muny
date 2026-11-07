# AI assistants

Muny can talk to AI assistants like Claude through MCP (the Model Context Protocol). An assistant can answer questions about your money, and build Overview cards and themes for you. Muny itself calls no AI service. Nothing connects until you create a token for it.

## What an assistant can and can't do

Each token only reaches what you tick when you make it:

| Permission               | What it allows                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Summaries                | Totals by category and merchant, budgets, recurring charges and upcoming bills            |
| Transactions             | Each transaction: merchant, amount, date, category, notes and tags                        |
| Accounts and investments | Account names and balances, net worth, stocks, crypto, savings, assets and document names |
| Loans and credit cards   | Balances, rates, payments and due dates                                                   |
| Build cards and themes   | Create and change Overview cards and themes, and arrange your Overview                    |

An assistant can't move money, change or delete financial data, read passwords or bank credentials, see full account numbers or the contents of your documents, or manage tokens. It can't delete cards or themes that people made. The limits also apply to data read through a card: a Summaries token can't see transactions by putting them on a card.

Anything that changes something is a dry run unless the assistant explicitly asks otherwise. Every call appears under **Activity** beside the token, and when a card or theme changes, the audit log keeps the version before it.

**Your privacy:** if the assistant runs on a cloud service, what it reads goes to that provider. Give it the fewest permissions that do the job, or connect a model running on your own machine for full privacy.

## Connecting

Only the household's owner can do this.

1. Go to **Settings → Agents**, name a token, tick what it can do, and create it. Muny shows the token once. Treat it like a password, and don't paste it into a chat with an assistant.
2. Connect your assistant. Muny shows the exact command for Claude Code, to run in your own terminal:

   ```
   claude mcp add --transport http muny https://your-muny-address/mcp --header "Authorization: Bearer muny_..."
   ```

   For other MCP clients, use the address `/mcp` on your Muny, with the same header.
3. Restart the assistant if it was already running, so it picks up the new tools.

**Use an HTTPS address.** MCP doesn't work reliably over plain HTTP, and a token sent that way can be read by others on the same network. Tailscale's HTTPS address is the easiest way to get one (see [Secure access](access.md)). The **Agents** page warns you when you've opened Muny without SSL, and the command it gives you uses whichever address you opened it from, so open Muny at your HTTPS address first. Don't expose Muny to the public internet for this.

To cut off a token, click **Revoke**. It stops working straight away.

## Things to ask

- "Where did my money go this month compared with last?"
- "Which subscriptions could I cut, and what would that save in a year?"
- "How long would my cash last at this rate?"
- "Make me an Overview card showing dining spending by month against my budget."
- "Make a dark green theme, and check it's readable."
- "Put my budget card at the top on my phone."

Assistants also get ready-made prompts: `savings_review`, `subscription_triage`, `debt_payoff_review` and `build_card`.

## Scripts

The same tools are available as a REST API, with the same token and permissions:

- `GET /api/v1/tools` lists what your token can use.
- `POST /api/v1/tools/<name>` calls one, with its input as JSON.
- `GET /api/v1/openapi.json` describes them all.

Money is always integer cents, so 12345 means $123.45.
