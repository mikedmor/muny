# Security

Muny holds sensitive financial data. Security is a core requirement, not a feature.

## Model

- **Self-hosted, LAN-first.** Muny is not hardened for direct internet exposure. Use a VPN or an authenticated reverse proxy with TLS.
- **No outbound traffic by default.** Bank sync, notifications and LLM providers are opt-in.
- **Secrets at rest:** bank/provider credentials are encrypted (AES-256-GCM) with `MUNY_SECRET_KEY`, which is supplied via the environment and never stored in the database.
- **Passwords:** argon2id. **API tokens:** shown once, stored hashed, scoped, expirable, audited.
- **Agents:** read-only by default. Writes go through approval and are audited. Agents can never touch credentials, tokens or bulk export.
- **No money movement**, ever.
- **No telemetry.**

## Rules for contributors

- Never commit real financial data, `.env` files, databases or bank exports. Test fixtures must be synthetic.
- Never log full account numbers, tokens, credentials or raw provider responses.
- New outbound network calls must be opt-in and documented.

## Reporting a vulnerability

Once the GitHub repository is public, please use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability"). Do not open public issues for security bugs.
