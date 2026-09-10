# Deploying gw-mailbox

Single container: PocketBase (API + hooks + cron + admin dashboard) serving the
Svelte SPA from `pb_public` on the same origin. No external database, no
message queue, no CORS setup. Works on any x86-64 (or arm64, see below) VPS.

---

## 1. Prerequisites

| Need | Why |
|---|---|
| A Linux VPS with **Docker + Docker Compose** | runs the app |
| A **domain** pointing at the VPS (A record) | HTTPS; required by Google OAuth |
| Ports **80 + 443** open | Caddy's Let's Encrypt challenge + HTTPS |
| A **Google Workspace** (not personal Gmail) | domain-wide delegation for the mailboxes |
| A **Google Cloud project** | service account + OAuth client |

---

## 2. Quick start (5 minutes)

```bash
git clone <repo> gw-mailbox && cd gw-mailbox
cp .env.example .env
$EDITOR .env          # set DOMAIN, MAILBOX_PUBLIC_URL, MAILBOX_ADMIN_EMAIL/PASSWORD
docker compose up -d --build
```

Then open `https://<your-domain>` and sign in with the admin credentials from
`.env` (use the **Admin** tab).

On first boot the app automatically:

* applies all schema migrations,
* sets PocketBase's **appURL** to `MAILBOX_PUBLIC_URL` (needed for OAuth2),
* sets the public base used in customer survey links,
* creates your **superuser** from `MAILBOX_ADMIN_EMAIL` / `MAILBOX_ADMIN_PASSWORD`,
* seeds demo data **only** if `MAILBOX_SEED_DEMO=1` *and* the data dir is empty.

> ⚠️ Keep `MAILBOX_SEED_DEMO=0` for anything a client will see: the demo seed
> creates working logins (`alice@demo.local` / `bob@demo.local` — `<<CREDENTIAL-REMOVED>>`)
> plus fake conversations.

---

## 3. Google Workspace setup

### 3a. Service account (this is what actually reads/sends the mail)

1. Google Cloud Console → create/choose a project → **IAM & Admin → Service Accounts → Create**.
2. Create a **JSON key** for it and download it.
3. Copy the service-account `client_email` (e.g. `svc@project.iam.gserviceaccount.com`).
4. **Enable the APIs**: Gmail API, Google Calendar API.
5. Google **Admin console** → **Security → Access and data control → API controls
   → Domain-wide delegation → Add new**:
   * Client ID = the service account's **OAuth client ID** (numeric — "Unique ID" of the SA)
   * Scopes:
     ```
     https://www.googleapis.com/auth/gmail.modify,
     https://www.googleapis.com/auth/gmail.send,
     https://www.googleapis.com/auth/calendar.events,
     https://www.googleapis.com/auth/calendar.readonly
     ```
6. Put the key into the app: **Settings → Connection → paste the JSON**, or set
   `GOOGLE_SA_JSON` / mount a file and set `GOOGLE_SA_FILE`.

### 3b. Google OAuth client (this is only for "Continue with Google" sign-in)

**Credentials → Create credentials → OAuth client ID → Web application**, then:

* **Authorized redirect URIs** (exact, no trailing slash):
  ```
  https://<your-domain>/auth/callback
  ```
* **Authorized JavaScript origins**: `https://<your-domain>`
* Configure the **OAuth consent screen** (scopes `userinfo.email`, `userinfo.profile`);
  while in *Testing*, add your users as **test users**.

Then in the app: **PocketBase dashboard** (`https://<domain>/_/`) → **Collections → users
→ Auth methods → OAuth2** → enable + add the **Google** provider with the
**Client ID / Client secret**.

The login screen shows the Google button automatically once that's saved.

---

## 4. Add mailboxes and start receiving mail

1. **Settings → Mailboxes → Add mailbox** (name + address).
2. Tick **“Import existing mail on setup”** if you want the mail already in that
   Gmail inbox pulled in (background import); leave it **off** to start fresh and
   only receive **new** incoming mail.
3. Grant that mailbox address in domain-wide delegation (step 3a) — sync scans the
   mailbox the service account impersonates.
4. **Settings → Connection → enable Poll sync** (or configure Pub/Sub for push).

---

## 5. Operations

### Backups (do this from day one)

All state lives in the `pb_data` Docker volume. PocketBase has a built-in backup:

```bash
# list / create
docker compose exec app /usr/local/bin/pocketbase backups create --dir=/app/pb_data
docker compose exec app ls /app/pb_data/backups

# copy a backup out of the volume
docker compose cp app:/app/pb_data/backups ./backups
```

A filesystem-level copy works too (stop the container first for consistency):

```bash
docker compose stop app
docker run --rm -v gw-mailbox_pb_data:/data -v "$PWD":/out alpine \
  tar czf /out/pb_data-$(date +%F).tgz -C /data .
docker compose start app
```

### Restore

```bash
docker compose stop app
docker run --rm -v gw-mailbox_pb_data:/data -v "$PWD":/in alpine \
  sh -c 'rm -rf /data/* && tar xzf /in/pb_data-YYYY-MM-DD.tgz -C /data'
docker compose start app
```

### Upgrade

```bash
git pull
docker compose up -d --build     # migrations apply automatically on boot
```

Changing `MAILBOX_PUBLIC_URL` later is fine — it's re-applied on every boot.
Never change `PB_ENCRYPTION_KEY` after data exists.

### Logs / health

```bash
docker compose logs -f app
curl -s https://<domain>/api/health
```

---

## 6. arm64 / other architectures

The binary committed to the repo is **linux/amd64**. On an arm64 host (Hetzner
Ampere, Oracle Ampere, Graviton, Raspberry Pi, Apple-silicon Docker) build with
the matching PocketBase release instead:

```bash
docker compose build --build-arg \
  PB_BINARY_URL=https://github.com/pocketbase/pocketbase/releases/download/v0.39.0/pocketbase_0.39.0_linux_arm64.zip \
  app
docker compose up -d
```

(or uncomment the `args:` block in `docker-compose.yml`).

---

## 7. Deployment without Docker

The container is a thin wrapper; the app needs only:

* the `pocketbase` binary,
* `pb_hooks/` (backend),
* `pb_migrations/` (schema),
* the built SPA served as `pb_public/` (build with `cd frontend && npm ci && npm run build`),
* `openssl` on PATH (JWT signing).

```bash
./pocketbase serve --http=0.0.0.0:8090 \
  --dir=/var/lib/gw-mailbox/pb_data \
  --publicDir=/opt/gw-mailbox/pb_public \
  --hooksDir=/opt/gw-mailbox/pb_hooks \
  --migrationsDir=/opt/gw-mailbox/pb_migrations
```

Put it behind nginx/Caddy for TLS, and run it under systemd with the same env
vars as `.env.example`.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Error 400: Missing required parameter: redirect_uri` | old build; update — the app now appends the redirect URI |
| Google sign-in lands on the PocketBase dashboard | old build; the callback is now `/auth/callback` |
| `redirect_uri_mismatch` | `https://<domain>/auth/callback` not registered exactly in the OAuth client |
| Sync does nothing, logs mention 403/unauthorized | domain-wide delegation missing for that mailbox address, or wrong scopes |
| Google button missing on login | users collection OAuth2 provider not configured (see 3b) |
| Customer survey links point at the wrong host | `MAILBOX_PUBLIC_URL` not set (it drives `appURL` + link base) |
| Deploy did nothing / old UI | asset cache (`max-age=14400`) — hard-refresh (Cmd/Ctrl+Shift+R) |
