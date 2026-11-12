# Email import

Some cards and accounts can't sync with [Plaid or Teller](bank-sync.md), but their bank emails you: an alert for each charge, and a note or a PDF when the statement is ready. Muny can read those emails from a mailbox you choose:

- **Card activity alerts** become transactions on the card.
- **Statement emails** update the card's statement balance, minimum payment and due date.
- **Statement PDFs** attached to an email are read into the card, as if you'd [imported them](rules-and-documents.md#statements), and kept in **Documents**.

It's off until you set it up in **Settings → Email**. It's read-only: Muny never marks, moves or deletes anything in your mailbox.

## Choosing a mailbox

Muny checks one folder of one mailbox over IMAP every few minutes. Pick either way:

- **A mailbox just for Muny** (the most private). Make a new address and have your main inbox forward your bank's emails to it. Muny never sees anything else.
- **A folder in your own mailbox.** Make a filter that puts your bank's emails into a folder, or a label in Gmail, and point Muny at that folder. There's no forwarding, but Muny holds a password for your whole mailbox.

Either way, use **automatic** forwarding or a filter. An email you forward by hand arrives from you, not from your bank, and Muny won't read it (see [Who Muny trusts](#who-muny-trusts)).

### Gmail

1. Turn on 2-Step Verification for the Google account, then make an **app password** at myaccount.google.com/apppasswords. Muny uses that, never your normal password.
2. For a folder in your own Gmail: make a filter for your bank's address with **Apply the label** (say, `Bank`). For a separate mailbox: in your main Gmail, add the new address under **Settings → Forwarding and POP/IMAP**, then make a filter for your bank's address with **Forward it to** that address.
3. In **Settings → Email**, choose **Gmail**, enter the address and app password, and type the label as the folder (`Bank`, or `INBOX` for a separate mailbox).

### Other providers

| Provider                       | What you need                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Fastmail**                   | An app password with IMAP access (Settings → Privacy & Security → Integrations)                                             |
| **iCloud Mail**                | An app-specific password from account.apple.com                                                                             |
| **Yahoo, AOL**                 | An app password (Account Info → Account security)                                                                           |
| **Zoho, GMX**                  | IMAP access turned on in the provider's settings                                                                            |
| **Your own server, Proton**    | Choose **Another server** and enter its IMAP address and port. Proton Mail Bridge needs **Allow a self-signed certificate** |
| **Outlook.com, Microsoft 365** | Not yet: Microsoft no longer accepts passwords for IMAP, and needs a sign-in with Microsoft instead                         |

**Test the connection** signs in and lists the folders, so you can check the name. Then turn on **Read this mailbox**. On the first check Muny reads back 30 days (you can change that), so recent statements come in too.

## Who Muny trusts

Muny only reads email from the **senders** you list: your bank's alert address, or its whole domain like `@yourbank.com`. Anything else in the folder is listed as **Sender not on your list** and left alone; **Allow this sender** adds it.

Anyone can send an email that _says_ it's from your bank, so by default Muny also needs your mail server's word that the bank's own domain signed it (DKIM). If your bank's real emails show up as **Not signed**, you can turn **Only email the sender's domain signed** off, but then a made-up email from that address could add a charge.

Emails only ever change the cards you've told Muny about, and everything an email adds can be undone from [Settings → History](undo.md).

## Teaching Muny your bank's emails

Every bank words its emails differently, so the first email of each kind lands under **Needs a look**. Press **Teach Muny**:

1. Say what kind it is: **card activity** (a charge, or a payment or refund) or a **statement summary**.
2. Copy each value from the email exactly as it's written: the amount, the merchant, the date and the card's last 4 digits, or the statement balance, minimum and due date. **Fill in with AI** does this for you if [built-in AI](ai.md) is on (it sends that email's text, long numbers hidden).
3. **Check what it reads** shows what Muny would take from the email. Muny remembers the words around each value, so the next email like it is read the same way, whatever the amount or merchant.
4. Choose the card if the email doesn't give its last 4 digits, and save.

Muny then reads the emails it kept that this applies to, and every new one as it arrives. Templates are listed under **What Muny has learned**.

## What happens to each email

| What arrives                                  | What Muny does                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A charge, payment or refund alert             | Adds the transaction to the card, marked **Email** as its source. Rules and merchant names apply as they do for an import. If it's already there (a statement brought it in), it's skipped |
| A statement summary                           | Sets the card's statement balance, minimum payment, due date and statement date, and its balance from then on                                                                              |
| A statement PDF                               | Reads it into the card when it's a card statement Muny can match by its last 4 digits, adding its transactions; other statements are kept under **Documents** for that account             |
| A PDF Muny can't open (often password-locked) | Kept under **Documents → Email**                                                                                                                                                           |

A statement that arrives later doesn't add the charges again: Muny skips any with the same amount within three days.

Emails are kept, encrypted, for 60 days, so you can teach Muny from them or read them again. After that only a line remains (sender, subject and what happened), so nothing is read twice.

## Privacy

- The mailbox password is stored encrypted with `MUNY_SECRET_KEY` and only ever sent to your mail server. Email import needs that key set.
- Muny connects out to your mail server and nowhere else. Nothing about your mail is logged.
- Only the household's owner can see or change Settings → Email.

---

[← All guides](README.md)
