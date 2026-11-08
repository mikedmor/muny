# Troubleshooting and FAQ

## Running Muny

<details>
<summary><strong>The container won't start, or keeps restarting</strong></summary>

Look at its logs: `docker logs muny` (or the container's **Log** tab in Container Manager or Unraid). The usual causes are:

- **Permission denied on `/data`:** the container's user must own the data folder. Run `id` on the host and set `user:` (Compose), `--user` (docker run) or **Extra Parameters** (Unraid) to that uid:gid, or `chown` the folder to it.
- **`MUNY_SECRET_KEY must be base64 encoding at least 32 bytes`:** generate it with `openssl rand -base64 32`, exactly as in the [install guide](install.md).
- **Port 8420 is taken:** map another host port, such as `-p 8430:8420`.
</details>

<details>
<summary><strong>The version in the menu didn't change after I updated</strong></summary>

A browser tab that was open across the update shows **Muny was updated. Reload to use it** at the top of the page. Reload it. To check what the server itself is running, open `/api/health`.
</details>

<details>
<summary><strong>I lost <code>MUNY_SECRET_KEY</code></strong></summary>

Your transactions, budgets and history are fine: they aren't encrypted with it. What's encrypted are bank connections, API and exchange keys, notification channel settings and stored documents. Set a new key, then reconnect banks and re-enter those keys. Documents stored under the old key can't be opened again.
</details>

<details>
<summary><strong>I forgot my password</strong></summary>

There's no email reset, because Muny never sends email on its own. If you can still sign in on another device, change it under **Settings → Household & account**. Otherwise restore a backup from before you changed it (see [Backups](backups.md#restoring-a-backup)), or open an issue on GitHub for help resetting it in the database.
</details>

## Data

<details>
<summary><strong>An account's balance doesn't match my bank</strong></summary>

Accounts made from a file start from a zero opening balance. Open **Accounts**, edit the account and set its current balance: Muny adjusts the opening balance so everything after adds up. Synced accounts use the balance your bank reports.
</details>

<details>
<summary><strong>I see the same transaction twice</strong></summary>

Imports skip transactions already in Muny, but two different sources (a Rocket Money export and a later bank sync, say) can describe one charge differently. Hide the extra one. When you first connect a bank, **link it to the account you already have** to avoid this; see [Bank sync](bank-sync.md#connecting).
</details>

<details>
<summary><strong>A recurring bill is missing, or something isn't really recurring</strong></summary>

Muny needs a few charges at a steady rhythm before it's confident. Press **Rescan** on Recurring, or open one of its transactions and set **Repeats** yourself. Mark false matches **Not recurring**. See [Recurring](recurring.md).
</details>

<details>
<summary><strong>A statement didn't read fully</strong></summary>

Use **Teach Muny** under the statement's name to show Muny where each value is; it remembers for every statement from that lender. With the [built-in AI](ai.md) on, **Fill in with AI** does it for you. See [Credit cards](cards.md#statements-muny-cant-read-yet).
</details>

## Connections

<details>
<summary><strong>A bank says "Needs login"</strong></summary>

Banks expire connections now and then, or after a password change. On **Accounts → Bank connections**, click **Log in again**. Your accounts and history stay as they are.
</details>

<details>
<summary><strong>An AI assistant can't connect over MCP</strong></summary>

MCP needs an HTTPS address. Open Muny at its `https://` address (Tailscale's is the easiest; see [Secure access](access.md)), create the token there, and use the command the **Agents** page shows. Restart the assistant after adding it. See [AI assistants](agents.md).
</details>

<details>
<summary><strong>Phone notifications don't arrive</strong></summary>

Push notifications need HTTPS, and on Android an installed app. Turn them on from **Alerts → Settings** on that device, and press **Send test**. See [Alerts](alerts.md).
</details>

## Still stuck?

Open an issue on [GitHub](https://github.com/mikedmor/muny/issues) with what you did, what you expected, and the relevant lines from `docker logs muny`. Leave out anything personal: account numbers, balances and real transactions are never needed to diagnose a problem. For security issues, follow [SECURITY.md](../SECURITY.md) instead.

---

[← All guides](README.md)
