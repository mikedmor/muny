# Secure access

## Keep it private

- Keep Muny on your home network, or reach it through a VPN (Tailscale, WireGuard) or a reverse proxy with TLS. **Don't port-forward it to the internet.**
- Muny requires a sign-in. The owner account is created on first visit. Use a strong password: the only account recovery is restoring a backup.

## HTTPS and access from anywhere with Tailscale (recommended)

[Tailscale](https://tailscale.com) (free for personal use) puts your server, phone and computers on a private network. With `tailscale serve`, Muny gets an HTTPS address like `https://nas.your-tailnet.ts.net` with a certificate that renews itself. It works away from home and **opens no router ports**: only your own signed-in devices can reach it.

HTTPS is also what lets you install Muny as a phone app and connect banks that log you in on their own website (OAuth banks such as Chase) through Plaid.

1. **Server:** install Tailscale and sign in. On a Synology NAS: DSM → Package Center → **Tailscale**.
2. **Tailscale admin console** → [DNS](https://login.tailscale.com/admin/dns): turn on **MagicDNS**, then **Enable HTTPS**.
3. **On the server** (needs `sudo`):

   ```sh
   sudo tailscale serve --bg 8420
   sudo tailscale serve status    # shows the https://….ts.net address
   ```

   This survives reboots. Undo it with `sudo tailscale serve --https=443 off`.
4. **Phone and laptop:** install the Tailscale app, sign in with the same account, and open the `https://….ts.net` address.

## A name on your home network (reverse proxy)

If your router or DNS server can point a name like `muny.home.example` at your server, a reverse proxy maps that name to Muny's port. On a Synology NAS: Control Panel → Login Portal → Advanced → **Reverse Proxy** → Create:

- **Source:** HTTP (or HTTPS with a certificate), hostname `muny.home.example`, port 80 (or 443)
- **Destination:** HTTP, `localhost`, port `8420`

Muny needs no extra headers behind a proxy.

## On your phone

Open Muny in your phone's browser and use **Add to Home Screen** (or **Install app**). Installing as an app needs HTTPS; over plain `http://` it works as a normal web page. Financial data is never stored in the browser's cache.

## Household members

Settings → Household & account → **Invite someone** creates a one-time link, valid for 7 days, for a **member** (full access) or a **viewer** (read-only). Muny doesn't send email; share the link yourself. Only the owner manages the household and backups.
