# Backups and export

## Automatic backups

Muny writes a consistent copy of its database to `data/backups/muny-YYYYMMDD-HHMMSS.db` once a day and keeps the newest 14 (see the backup settings in [Install](install.md#settings)). You can also click **Settings → Data & backups → Back up now**, and download any backup from there.

These backups sit on the same disk as the database. Also copy Muny's folder, especially `data/` and `.env`, somewhere else: on a Synology NAS, include it in **Hyper Backup**.

## Restoring a backup

1. Stop the container (`docker compose stop`, or Stop in Container Manager).
2. In `data/`, move `muny.db` (and any `muny.db-wal` and `muny.db-shm` files) somewhere safe.
3. Copy the backup you want into `data/` and rename it to `muny.db`. Keep the data folder's owner and permissions (`chown` it to the container's user if needed).
4. Start the container again. Migrations run automatically if the backup is from an older version.

A backup is only readable with the same `MUNY_SECRET_KEY` for the encrypted parts (bank connections, API keys, tax forms), so keep `.env` with your backups.

## Exporting your data

**Settings → Data & backups** exports every transaction as CSV, or everything (accounts, categories, merchants, tags, rules, transactions and investments) as JSON, for moving to another tool.
