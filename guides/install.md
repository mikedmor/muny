# Install

Muny runs as a single Docker container with a SQLite database. Images for amd64 (most PCs and Intel/AMD NASes) and arm64 (Raspberry Pi 4/5, Apple silicon, ARM NASes) are published as `ghcr.io/mikedmor/muny`.

| Tag      | What you get                                                   |
| -------- | -------------------------------------------------------------- |
| `1`      | The latest 1.x release. Recommended: updates never break setup |
| `1.0.0`  | Exactly that release                                           |
| `latest` | The newest release, including future major versions            |

Every install needs the same three things:

- **A data folder** mounted at `/data`. It holds `muny.db` and its backups.
- **`MUNY_SECRET_KEY`**: 32 random bytes, base64. Bank connections, API keys and uploaded documents are encrypted with it. Generate it once with `openssl rand -base64 32` and **keep a copy somewhere safe**, like a password manager: without it you'd have to reconnect everything.
- **Port 8420**, where Muny listens.

Then open `http://<host>:8420` and create the owner account. To look around before adding your own accounts, start it once with `MUNY_DEMO=true` (see [Try it with demo data](#try-it-with-demo-data)).

## Any Docker host (Docker Compose)

```sh
mkdir -p muny/data && cd muny
chmod 700 data
umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
id   # note your uid:gid for compose.yaml
```

Create `compose.yaml`:

```yaml
services:
  muny:
    image: ghcr.io/mikedmor/muny:1
    container_name: muny
    restart: unless-stopped
    user: "1000:1000" # your uid:gid from `id`; must own ./data
    ports:
      - "8420:8420"
    environment:
      TZ: America/New_York # your time zone
    env_file: .env
    volumes:
      - ./data:/data
```

Start it with `docker compose up -d`. To update: `docker compose pull && docker compose up -d`.

Without Compose:

```sh
docker run -d --name muny --restart unless-stopped \
  --user "$(id -u):$(id -g)" -p 8420:8420 \
  -e TZ=America/New_York --env-file .env \
  -v "$PWD/data:/data" ghcr.io/mikedmor/muny:1
```

## Synology NAS (DSM 7, Container Manager)

Tested on a DS920+ with DSM 7.4.

1. In **File Station**, create the folder `docker/muny/data`.
2. **Find your user's ids:** enable SSH (Control Panel → Terminal & SNMP), sign in and run `id`. Note the `uid` and `gid` (often `1026` and `100`).
3. **Create the secret key** over SSH:

   ```sh
   cd /volume1/docker/muny
   umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
   ```

4. In **Container Manager → Project → Create**, choose the path `/docker/muny`, pick **Create docker-compose.yml**, and paste the `compose.yaml` above with your `user:` ids. Container Manager pulls the image and starts it.

Then open `http://NAS_IP:8420`. To update, open the project, choose **Action → Build** (it pulls the newest `1` image), or over SSH run `sudo docker compose pull && sudo docker compose up -d` in the folder.

## Unraid

1. **Docker → Add Container**, switch to **Advanced View**, and set:

   | Field            | Value                                                                                     |
   | ---------------- | ----------------------------------------------------------------------------------------- |
   | Name             | `muny`                                                                                    |
   | Repository       | `ghcr.io/mikedmor/muny:1`                                                                 |
   | Extra Parameters | `--user 99:100` (Unraid's `nobody:users`)                                                 |
   | WebUI            | `http://[IP]:[PORT:8420]`                                                                 |
   | Port             | Container `8420` → Host `8420`                                                            |
   | Path             | Container `/data` → Host `/mnt/user/appdata/muny`                                         |
   | Variable         | Key `MUNY_SECRET_KEY`, value from `openssl rand -base64 32` (run it in Unraid's terminal) |
   | Variable         | Key `TZ`, value your time zone, e.g. `America/New_York`                                   |

2. **Apply.** Unraid creates `/mnt/user/appdata/muny` owned by `nobody:users`, which matches `--user 99:100`.

Copy the `MUNY_SECRET_KEY` value somewhere safe too: it's stored in the container template, and it's the only way to decrypt bank connections after a rebuild. Updates come through Unraid's **Check for Updates** on the Docker tab.

## Try it with demo data

Add `MUNY_DEMO=true` to the environment (in `.env`, or as a variable on Synology or Unraid) before you create the owner account. Muny fills the fresh install with a made-up household: accounts, six months of transactions, bills, subscriptions, budgets and a loan, so every page has something to show.

A banner says it's demo data. When you're ready, **Settings → Data → Start clean** removes it and everything you added to it, keeping your login, settings and themes. You can leave `MUNY_DEMO` set or remove it: Muny won't fill the household again.

## Build from source

To run unreleased changes, build the image yourself from a checkout:

```sh
git clone https://github.com/mikedmor/muny.git && cd muny/docker
mkdir -p data && chmod 700 data
umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

The first build takes a few minutes (about 6 on a DS920+).

## Settings

Settings are environment variables. They're read at startup, so recreate the container after changing them (`docker compose up -d`).

| Variable                     | Default          | Meaning                                                                |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `MUNY_SECRET_KEY`            | (required)       | Encrypts stored credentials. Generate once, keep a copy safe.          |
| `MUNY_PUBLIC_URL`            | none             | Muny's address, used for links in alerts (e.g. `https://muny.example`) |
| `MUNY_DEMO`                  | `false`          | `true` fills a fresh install with a made-up household to try           |
| `MUNY_SYNC_INTERVAL_HOURS`   | `6`              | How often bank sync runs; `0` turns it off                             |
| `MUNY_BACKUP_DIR`            | `<data>/backups` | Where backups are written                                              |
| `MUNY_BACKUP_KEEP`           | `14`             | How many backups to keep                                               |
| `MUNY_BACKUP_INTERVAL_HOURS` | `24`             | Hours between backups; `0` turns automatic backups off                 |
| `TZ`                         | `UTC`            | Your time zone, so "today" and due dates are right                     |

Bank sync keys are covered in [Bank sync](bank-sync.md).

## Upgrading

Back up first (Muny keeps automatic backups in `data/backups`; see [Backups](backups.md)), then pull the new image and recreate the container. Database changes run on their own at startup. What changed in each version is in the [changelog](../CHANGELOG.md).

## Next steps

- [Getting started](getting-started.md): a tour of your first hour.
- [Secure access](access.md): keep Muny private and get HTTPS.
- [Importing files](importing.md) or [Bank sync](bank-sync.md): bring in your accounts.

---

[← All guides](README.md)
