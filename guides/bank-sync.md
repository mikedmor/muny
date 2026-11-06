# Bank sync

Muny can pull transactions and balances automatically through **Plaid** or **Teller**, using **your own** developer account with them. Nothing goes through the Muny project or anyone else. Without either, everything still works through [file import](importing.md).

Keys go in the `.env` file next to `compose.yaml` (`chmod 600`, never in git). Recreate the container after editing it: settings are only read at startup.

Muny syncs every 6 hours (`MUNY_SYNC_INTERVAL_HOURS`; `0` turns it off), and you can press **Sync now** on the Accounts page. Plaid and Teller are only contacted when configured, and the browser only loads their connection widgets when you click **Connect**.

## Plaid

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/signup). New US and Canadian teams can use the free **Trial plan** ([dashboard.plaid.com/trial-plan](https://dashboard.plaid.com/trial-plan)), which includes Transactions with real data for a limited number of bank logins. Removing a login doesn't free its slot. Check [Plaid's billing docs](https://plaid.com/docs/account/billing/) for current terms before you apply for anything else.
2. Under **Developers → Keys**, copy your `client_id` and the **Sandbox** secret, and try it with sandbox first:

   ```sh
   PLAID_CLIENT_ID=your_client_id
   PLAID_SECRET=your_sandbox_secret
   PLAID_ENV=sandbox
   ```

   In Plaid's sandbox, log in with `user_good` / `pass_good`.
3. When that works, switch to the **Production** secret and set `PLAID_ENV=production`. Each bank you connect uses one Trial login, so connect only the banks you'll keep.
4. **OAuth banks** (Chase, Capital One, Wells Fargo, Bank of America and others) send you to the bank's own site to log in. That needs Muny on a fixed **HTTPS** address (see [Secure access](access.md)):
   - In the Plaid dashboard, add `https://<your address>/oauth/plaid` under **Developers → API → Allowed redirect URIs**.
   - Set `PLAID_REDIRECT_URI=https://<your address>/oauth/plaid` in `.env`, and open Muny through that address when connecting.
   - The address doesn't have to be reachable from the internet. Only your own browser follows the redirect; its certificate just has to be trusted by your browser. Tailscale's `*.ts.net` certificates work and need no open ports.

## Teller

> Teller stopped accepting new developers in 2026. Existing Teller accounts can still use this setup.

1. From your Teller dashboard, copy the **Application ID** and download the **certificate** (`certificate.pem` and `private_key.pem`).
2. Put both files in `data/teller/` and make them readable only by the container's user:

   ```sh
   mkdir -p data/teller && chmod 700 data/teller && chmod 600 data/teller/*.pem
   ```

3. Add to `.env`:

   ```sh
   TELLER_APPLICATION_ID=app_xxxxxxxx
   TELLER_ENV=development        # sandbox for fake data; development for your real accounts
   TELLER_CERT_PATH=/data/teller/certificate.pem
   TELLER_KEY_PATH=/data/teller/private_key.pem
   ```

## Connecting

On **Accounts → Bank connections**, click **Connect**. After you log in to your bank, choose where each bank account goes. **Link it to an account you already have** (for example one from a Rocket Money import) to keep its history: transactions you already imported are matched instead of duplicated. From then on the account shows the bank's reported balance.

If a bank needs you to log in again (a password change or expired consent), the connection shows **Needs login**; click **Log in again**. **Disconnect** keeps the accounts and their history; they just stop updating.
