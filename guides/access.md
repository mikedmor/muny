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

Open Muny in your phone's browser and go to **Settings → This device → Install Muny**, or use the browser's **Add to Home Screen** (or **Install app**). Installing as an app needs HTTPS; over plain `http://` it works as a normal web page. Installed, Muny opens in its own window, shows how many alerts are unread on its icon, and has shortcuts to Transactions, Alerts, Budgets and Recurring when you long-press the icon.

### Android app

There's also a small Android app. It shows your Muny in its own window, with no browser involved: no address bar and no browser badge. It asks for your Muny address the first time, and can ask for your fingerprint or screen lock when it opens and again after 5 minutes away (on by default). Install the app file (`.apk`) attached to a Muny release, from release 1.5 on (allow installing apps from your browser or file manager when Android asks). It needs Muny's HTTPS address; a home root certificate installed on the phone works too.

The app keeps its own sign-in, so sign in once in the app. Turn its notifications on in **Alerts → Settings → Turn on notifications here**; they arrive through Google Play services, encrypted so only your phone can read them, with nothing to set up (see [Alerts](alerts.md#in-the-android-app)). In the app, **Keep a copy of my data on this device** is on unless you turn it off (see below).

### Using it offline

In a browser, nothing financial is stored on your phone by default: when Muny can't be reached (no signal, Tailscale off, server restarting) it says so and shows only what's already on screen. To open it with your last data instead, turn on **Settings → This device → Keep a copy of my data on this device**. Muny then keeps the pages you've visited, as of the last time it could reach the server, and opens with them offline, with a banner showing how old they are. Nothing can be changed until it's back online.

The copy is encrypted with a key that never leaves that browser, and is deleted when you sign out or turn the setting off. Turn it on only on a phone or computer that only you use. It needs Muny's HTTPS address.

## Household members

Settings → Household & account → **Invite someone** creates a one-time link, valid for 7 days, for a **member** (full access) or a **viewer** (read-only). Muny doesn't send email; share the link yourself. Only the owner manages the household and backups.

---

[← All guides](README.md)
