# Backups and export

Everything Muny knows lives in one SQLite file, `data/muny.db`. Backing up Muny means keeping copies of that file and of your `MUNY_SECRET_KEY`.

## Automatic backups

Muny writes a consistent copy of its database to `data/backups/muny-YYYYMMDD-HHMMSS.db` once a day and keeps the newest 14. Change the schedule and how many to keep with these settings (see [Install → Settings](install.md#settings)):

| Setting                      | Default        | Meaning                                                |
| ---------------------------- | -------------- | ------------------------------------------------------ |
| `MUNY_BACKUP_INTERVAL_HOURS` | `24`           | Hours between backups; `0` turns automatic backups off |
| `MUNY_BACKUP_KEEP`           | `14`           | How many to keep                                       |
| `MUNY_BACKUP_DIR`            | `data/backups` | Where they're written                                  |

**Settings → Data & backups** lists every backup with **Back up now** and a download link for each. Only the household owner can see backups, because they contain everything, password hashes included.

> [!IMPORTANT]
> Backups on the same disk don't protect you from that disk failing. Copy Muny's folder, especially `data/` and `.env`, somewhere else as well. On a Synology NAS, include it in **Hyper Backup**; on Unraid, in your appdata backup.

## What a backup contains

Every account, transaction, budget, rule, setting, document and theme. The parts encrypted with `MUNY_SECRET_KEY` (bank connections, API and exchange keys, notification channel settings and documents) can only be read with the same key, so **keep `.env` with your backups**, or the key in your password manager.

## Restoring a backup

1. Stop the container: `docker compose stop`, or **Stop** in Container Manager or Unraid.
2. In `data/`, move `muny.db`, and any `muny.db-wal` and `muny.db-shm` files beside it, somewhere safe.
3. Copy the backup you want into `data/` and rename it to `muny.db`. Keep the folder's owner and permissions (`chown` it to the container's user if needed).
4. Start the container again. If the backup is from an older version, its database is brought up to date on startup.

## Moving to a new server

1. Stop Muny on the old server.
2. Copy the whole Muny folder (`data/`, `.env` and `compose.yaml`) to the new one.
3. Make sure the container's user owns `data/` there, then start it.

Your accounts, history and settings come along. Bank connections keep working as long as `MUNY_SECRET_KEY` is the same.

## Upgrading

Muny checks and updates its database on its own when a new version starts. Before a big upgrade, press **Back up now** (or copy `data/`), then pull the new image and recreate the container. The [changelog](../CHANGELOG.md) lists what changed in each version, and a major version (2.0, say) says there if anything needs doing.

## Exporting your data

Your data is yours. **Settings → Data & backups** exports:

- **Transactions (CSV):** every transaction, opening in any spreadsheet. Split transactions get one row per part.
- **Everything (JSON):** accounts, categories, merchants, tags, rules, transactions and investments, for moving to another tool or keeping a readable archive.

---

[← All guides](README.md)
