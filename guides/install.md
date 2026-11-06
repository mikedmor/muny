# Install

Muny runs as a single Docker container with a SQLite database. Until images are published to GHCR, you build the image from source on your Docker host.

## Any Docker host

From a checkout of this repository:

```sh
cd docker
mkdir -p data && chmod 700 data
umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
docker compose up -d --build
```

Set `user:` in [docker/compose.yaml](../docker/compose.yaml) to the uid:gid that owns `./data` (run `id` to see yours). Then open `http://<host>:8420` and create the owner account.

**Back up `.env`** somewhere safe and separate, such as a password manager. Bank connections, API keys and uploaded tax forms are encrypted with `MUNY_SECRET_KEY`. Without it you'd have to reconnect everything.

To update, pull the latest code and run `docker compose up -d --build` again. Database migrations run automatically on startup.

## Synology NAS (DSM 7, Container Manager)

Tested on a DS920+ (Intel J4125, 4 GB RAM) with DSM 7.4 and Container Manager. The first build takes about 6 minutes; later builds are faster.

1. **Enable SSH:** Control Panel → Terminal & SNMP → Enable SSH service.
2. **Let your user run Docker** (over SSH):

   ```sh
   sudo /usr/syno/sbin/synogroup --add docker YOURUSER      # or --memberadd if the group exists
   sudo chown root:docker /var/run/docker.sock
   ```

   DSM updates may reset the socket's owner; rerun the `chown` if Docker says permission denied. The `docker` binary is at `/usr/local/bin/docker`.
3. **Create the app folder:**

   ```sh
   mkdir -p /volume1/docker/muny/data && cd /volume1/docker/muny
   chmod 700 data
   umask 077; printf "MUNY_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" > .env
   id                                  # note your uid:gid
   ```

4. **Copy the source** into `/volume1/docker/muny/src` (for example `git clone` it there, or copy a release archive).
5. **Create `/volume1/docker/muny/compose.yaml`:**

   ```yaml
   services:
     muny:
       build:
         context: ./src
         dockerfile: Dockerfile
       image: muny:local
       container_name: muny
       restart: unless-stopped
       user: "1026:100"          # your uid:gid from `id`; must own ./data
       ports:
         - "8420:8420"
       environment:
         TZ: America/New_York    # your time zone
       env_file: .env
       volumes:
         - ./data:/data
   ```

6. Build and start it: `cd /volume1/docker/muny && docker compose up -d --build`, or create a project from this folder in Container Manager.

Then open `http://NAS_IP:8420`. The folder looks like this:

```
/volume1/docker/muny/
├── compose.yaml
├── .env           # MUNY_SECRET_KEY and any bank keys (chmod 600)
├── data/          # muny.db and backups/
└── src/           # the source code
```

## Settings

Settings are environment variables in `.env`. They're only read at startup, so recreate the container after changing them (`docker compose up -d`).

| Variable                     | Default          | Meaning                                                                |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `MUNY_SECRET_KEY`            | (required)       | Encrypts stored credentials. Generate once, keep a copy safe.          |
| `MUNY_PUBLIC_URL`            | none             | Muny's address, used for links in alerts (e.g. `https://muny.example`) |
| `MUNY_SYNC_INTERVAL_HOURS`   | `6`              | How often bank sync runs; `0` turns it off                             |
| `MUNY_BACKUP_DIR`            | `<data>/backups` | Where backups are written                                              |
| `MUNY_BACKUP_KEEP`           | `14`             | How many backups to keep                                               |
| `MUNY_BACKUP_INTERVAL_HOURS` | `24`             | Hours between backups; `0` turns automatic backups off                 |

Bank sync keys are covered in [Bank sync](bank-sync.md).

## Next steps

- [Secure access](access.md): keep Muny private and get HTTPS.
- [Importing files](importing.md) or [Bank sync](bank-sync.md): bring in your accounts.
