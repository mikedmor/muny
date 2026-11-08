# AI assistants

Muny can talk to AI assistants like Claude through MCP (the Model Context Protocol). An assistant can answer questions about your money, build Overview cards and themes for you, and suggest changes that wait for your approval. Nothing connects until you create a token for it.

Here the assistant runs elsewhere and connects to Muny. Muny can also use an AI model itself for a few jobs, which is separate and off by default: see [Built-in AI](ai.md).

## What an assistant can and can't do

Each token only reaches what you tick when you make it:

| Permission                            | What it allows                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Summaries                             | Totals by category and merchant, budgets, recurring charges and upcoming bills                            |
| Transactions                          | Each transaction: merchant, amount, date, category, notes and tags                                        |
| Accounts and investments              | Account names and balances, net worth, stocks, crypto, savings, assets and document names                 |
| Loans and credit cards                | Balances, rates, payments and due dates                                                                   |
| Build cards and themes                | Create and change Overview cards and themes, and arrange your Overview                                    |
| Suggest categories, tags and notes    | Suggest categorizing and tagging transactions, adding notes, and confirming or ignoring recurring charges |
| Suggest rules                         | Suggest rules for transactions                                                                            |
| Suggest budgets                       | Suggest monthly budgets                                                                                   |
| Suggest savings and replacement plans | Suggest recording savings, and plans to replace paid services                                             |

An assistant can't move money, change or delete financial data on its own, read passwords or bank credentials, see full account numbers or the contents of your documents, or manage tokens. It can't delete cards or themes that people made. The limits also apply to data read through a card: a Summaries token can't see transactions by putting them on a card.

Anything that changes something is a dry run unless the assistant explicitly asks otherwise. Cards, themes and layout then apply directly; anything touching financial data goes to your inbox instead (see below). Every call appears under **Activity** beside the token, and when a card or theme changes, the audit log keeps the version before it.

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

## Approving what an assistant suggests

When an assistant suggests a change to your financial data, nothing happens until you approve it. Suggestions wait under **Alerts → Inbox**, and you get an alert when new ones arrive. You can send that alert to your phone or email under **Alerts → Settings**. It only says something is waiting, not what.

Each suggestion shows exactly what would change, worked out by Muny from your data, with the assistant's reason labelled as its own words. **Approve** or **Reject** each one, or use **Approve all** and **Reject all**.

If something changed after the suggestion was made, like you recategorizing that transaction yourself, Muny won't apply it and tells you why. Suggestions you leave expire after 30 days. Assistants can see what became of their suggestions, but can't approve them.

An older token only has the permissions it was made with, so make a new one to allow suggestions.

## Things to ask

- "Where did my money go this month compared with last?"
- "Which subscriptions could I cut, and what would that save in a year?"
- "How long would my cash last at this rate?"
- "Make me an Overview card showing dining spending by month against my budget."
- "Make a dark green theme, and check it's readable."
- "Put my budget card at the top on my phone."
- "Find my uncategorized transactions and suggest categories."
- "Suggest a rule so this merchant always goes in Groceries."
- "Suggest budgets based on the last three months."

Assistants also get ready-made prompts: `savings_review`, `subscription_triage`, `debt_payoff_review` and `build_card`.

## Scripts

The same tools are available as a REST API, with the same token and permissions:

- `GET /api/v1/tools` lists what your token can use.
- `POST /api/v1/tools/<name>` calls one, with its input as JSON.
- `GET /api/v1/openapi.json` describes them all.

Money is always integer cents, so 12345 means $123.45.

---

[← All guides](README.md)
