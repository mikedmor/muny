# Alerts

Muny checks for alerts every 5 minutes:

- bills coming due and free trials ending (remind as many times as you like, e.g. 7 days and 1 day before)
- low balances, and balances headed low: an account expected to drop below its low-balance amount within the next 14 days (see [Forecast](reports.md#forecast))
- large, unusual or duplicate charges
- price increases on subscriptions
- budgets reaching the percentages you choose: 80% and 100% to start; add or remove as many as you like (turn them off for one category with **Budget alerts** in that category's **Edit** dialog)
- charges after you cancelled something
- banks that need you to log in again
- a service in Settings → API using up its requests for the day or month, with how long until they reset
- price alerts you set on a stock or coin (from its bell), checked as live prices arrive rather than every 5 minutes: see [Stocks](stocks.md#live-prices-and-price-alerts)
- a new version of Muny, once per release, when the update check is on: see [Install → Upgrading](install.md#upgrading)

Every alert appears under **Alerts** in Muny (the bell).

- **Alerts for an account** (a low balance, large charges, unusual charges, possible duplicates) are set on each account: on **Accounts**, click the bell next to it. A ringing bell means a low-balance or large-charge alert is on. Unusual charges and possible duplicates are on for new accounts.
- **Everything else** (bills, trials, budgets, price increases, charges after cancelling, banks needing attention) is on **Alerts → Settings**.

## Notifications on your phone or computer

On **Alerts → Settings**, click **Turn on notifications here** on each device you want alerts on. On Android, install Muny first: open it in Chrome over HTTPS (your Tailscale address), then browser menu → **Install app**, and turn notifications on from the installed app. On Windows, Edge or Chrome works the same way (installed or in a tab). Alerts then arrive like any app's, even with Muny closed. The [Android app](access.md#android-app) works the same way, once Muny is set up for it (below).

Each notification opens the page it's about when tapped, and has **Mark read** (without opening Muny) and **Open** buttons. A newer alert of the same kind replaces the older one instead of stacking up. The installed app's icon shows how many alerts are unread.

Each device becomes a channel. The **Where each alert goes** grid has a row per alert (account alerts together) and a column per device or channel: tick which alerts each one gets, or **All** / **None**. A new device starts with every alert that's on.

Notifications go through the browser's own push service (Google for Chrome and Android, Microsoft for Edge, Mozilla for Firefox, Apple for Safari), encrypted so only that device can read them; Muny contacts it only for devices you turned on. A device that turns notifications off is switched off here too.

### In the Android app

In the [Android app](access.md#android-app), turn notifications on the same way: **Alerts → Settings → Turn on notifications here**. There's nothing to set up on your server or to install on the phone. Alerts arrive through Google Play services, like any app's.

To get there, Muny hands each alert to the app's push relay, which passes it to Google for delivery. Each alert is encrypted on your server for that one phone (the same encryption browsers use for notifications), so neither the relay nor Google can read it: they only see the phone's push token and scrambled data. Nothing is sent unless notifications are on in the app.

- **Turn app notifications off** for your whole Muny with `MUNY_PUSH_RELAY=off`.
- **Run your own relay** (it's a small Cloudflare Worker in the app-shell project) and point `MUNY_PUSH_RELAY` at it, or skip the relay entirely with your own Firebase key in `MUNY_FCM_CREDENTIALS`. Both only work with a copy of the app built with your own Firebase project.

## Getting alerts by email or other apps

Add a **channel** on Alerts → Settings, and tick it for the alerts you want sent there (one tick covers all account alerts). Muny only contacts channels you add, and only sends the alert's title, a short description and a link, never account numbers or logins. Channel settings (URLs, tokens, passwords) are stored encrypted.

- **ntfy** (simplest phone push): install the ntfy app, subscribe to a long, hard-to-guess topic, and add that topic in Muny. Works with ntfy.sh or your own ntfy server.
- **Apprise:** point Muny at an [Apprise API](https://github.com/caronc/apprise-api) URL to reach Discord, Telegram, Pushover, Slack and 100+ others.
- **Email (SMTP):** your provider's SMTP server. For Gmail use `smtp.gmail.com`, port 465, and an [app password](https://myaccount.google.com/apppasswords).
- **Webhook:** Muny POSTs JSON `{ event, type, severity, title, body, url, createdAt }`. With a secret, it adds `X-Muny-Signature: sha256=<HMAC of the body>`.

Set `MUNY_PUBLIC_URL` (for example `https://muny.your-tailnet.ts.net`) so alerts include a link that opens Muny. Use **Send test** on a channel to check it works.

---

[← All guides](README.md)
