# Security

Muny holds some of the most sensitive data a person has. Security is a requirement in every part of it, not a feature added later.

## Supported versions

Security fixes go into the latest release. Run the newest `1.x` image (`ghcr.io/mikedmor/muny:1`) to receive them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. Never include real financial data; a synthetic example is always enough. You'll get an acknowledgement, and credit in the release notes if you'd like it.

## Security model

### Where Muny runs

- **Self-hosted and private.** Muny is designed for a home network or a VPN such as Tailscale, behind TLS. It isn't hardened for direct exposure to the internet, so don't port-forward it.
- **Sign-in required.** Every page and API call needs a session or a token. Sign-in attempts are rate limited.

### Data

- **One database, on your disk.** No copy goes anywhere else, and there's no telemetry.
- **Secrets encrypted at rest** with AES-256-GCM, using keys derived from `MUNY_SECRET_KEY`: bank and provider tokens (Plaid, Teller, PayPal), exchange and service API keys, notification channel settings, wallet addresses, the built-in AI's key, and stored documents. The key comes from the environment and is never stored in the database.
- **Passwords** are hashed with argon2id.
- **Logs** never contain account numbers, tokens, credentials or raw provider responses.

### Outbound connections

Muny makes no outbound connection by default. Each one below happens only after you set it up, and its guide documents exactly what's sent:

| Feature                | Contacts                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Bank sync              | Plaid, Teller or PayPal, with your own keys                                             |
| Prices and wallet sync | Price and blockchain services you turn on (sends coin ids or addresses, never balances) |
| Stocks extras          | Yahoo Finance and logo providers, when turned on (sends ticker symbols only)            |
| Asset values           | APillow and CarAPI, with your own keys                                                  |
| Notifications          | Only the channels you add, and the browser's push service for devices you turn on       |
| Built-in AI            | The provider you choose, only for the features you turn on                              |

### People and roles

- **Owner:** manages the household, backups, AI access and tokens.
- **Member:** full access to the household's money.
- **Viewer:** read-only, enforced on the server.

Invites are single-use links, stored hashed, that expire after 7 days.

### AI assistants

- **Tokens** are shown once, stored hashed, scoped to the permissions you choose, can expire, and are rate limited. Every call is in the token's activity log.
- **Read-only by default.** Anything that changes financial data becomes a suggestion in the approval inbox. Nothing happens until a person approves it, and Muny re-checks it against current data first.
- Assistants can never reach passwords, credentials, other tokens, document contents or bulk export.
- **Muny never moves money**, whoever asks.

## For contributors

- Never commit real financial data, `.env` files, databases or bank exports. Test fixtures are synthetic.
- Never log account numbers, tokens, credentials or raw provider responses.
- Provider certificates and keys (such as Teller's) live in the data volume, never in the repository or the image.
- A new outbound network call must be opt-in and documented in the guide for its feature.
