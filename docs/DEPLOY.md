# Deploying gw-mailbox

Single container: PocketBase (API + hooks + cron + admin dashboard) serving the
Svelte SPA from `pb_public` on the same origin. No external database, no
message queue, no CORS setup. The published image is **linux/amd64** — on arm64
see §6, which means building from source.

Nothing needs to be compiled to deploy this. The image is published to GHCR and
pulled at deploy time, so the host needs Docker and nothing else.

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

You need three files on the host: `docker-compose.yml`, `Caddyfile` and
`.env.example`. Fetch them without cloning anything:

```bash
mkdir gw-mailbox && cd gw-mailbox
BASE=https://raw.githubusercontent.com/wannaco/gw-mailbox/main
curl -fsSLO $BASE/docker-compose.yml
curl -fsSLO $BASE/Caddyfile
curl -fsSLO $BASE/.env.example

cp .env.example .env
$EDITOR .env          # set DOMAIN, MAILBOX_PUBLIC_URL, MAILBOX_ADMIN_EMAIL/PASSWORD
docker compose up -d
```

The app image (`ghcr.io/wannaco/gw-mailbox:latest`) is public — no registry login
needed. `docker compose up -d` pulls it; there is no build step.

> `docker compose pull && docker compose up -d` is the way to take an upgrade.
> The compose file sets `pull_policy: always` — do not remove it. Without it,
> Compose only pulls when the image is absent, so `up -d` reports success while
the old container keeps running.

Then open `https://<your-domain>` and sign in with the admin credentials from
`.env` (use the **Admin** tab).

On first boot the app automatically:

* applies all schema migrations,
* sets PocketBase's **appURL** to `MAILBOX_PUBLIC_URL` (needed for OAuth2),
* sets the public base used in customer survey links,
* creates your **superuser** from `MAILBOX_ADMIN_EMAIL` / `MAILBOX_ADMIN_PASSWORD`,
* seeds demo data **only** if `MAILBOX_SEED_DEMO=1` *and* the data dir is empty.

> ⚠️ Keep `MAILBOX_SEED_DEMO=0` for anything a client will see: the demo seed
> creates working logins (`alice@demo.local` / `bob@demo.local`, password from
> `MAILBOX_DEMO_PASSWORD`) plus fake conversations.

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

### 3c. Recommended: Google-only sign-in

**There are two separate account systems, and this is the single most confusing
thing about the setup.** They are independent records that often share an email
address but have their own password and their own auth methods:

| | `users` — agents | `_superusers` — admin |
|---|---|---|
| Used for | signing in to the app | the PocketBase dashboard `/_/`, provisioning inboxes/agents |
| Created by | Settings → People, or the demo seed | the `MAILBOX_ADMIN_*` env vars on **first boot**, or manually |
| Google SSO | **yes** (once 3b is done) | **no — not supported by PocketBase** |
| Password auth | can be disabled | always on (the only option) |

Because `_superusers` cannot use OAuth2, "turn on Google login" only ever covers
the agent side. The admin dashboard stays password-based.

**Recommended configuration:**

1. Complete 3b (Google OAuth client + provider on the `users` collection).
2. Verify Google sign-in works for one real user before going further.
3. **Disable password auth on `users`**: dashboard `/_/` → **Collections → users →
   Auth methods → uncheck Password**. Agents then sign in with Google only.
4. Give every agent a **Google Workspace account on your own domain** — that
   address is what maps to their user record.
5. Protect the dashboard (see below) and set a strong, unique superuser password.

After step 3, `POST /api/collections/users/auth-with-password` returns **403** for
everyone, including any account that still has a stored password. Those passwords
become unusable rather than being deleted, so nothing is lost if you re-enable later.

> ⚠️ **Do not enable the demo seed (`MAILBOX_SEED_DEMO=1`) together with
> Google-only sign-in.** The demo accounts (`alice@demo.local`, `bob@demo.local`)
> are password logins with no Google identity, so they can never sign in. Keep the
> demo seed for password-auth or throwaway instances only.

> ⚠️ **Rotating an agent's password does not touch the superuser, and vice versa.**
> If (say) `admin@yourdomain.com` exists as both a `users` record and a
> `_superusers` record, changing one leaves the other exactly as it was. Both must
> be changed separately — see *Accounts and passwords* in Operations.

### 3d. Protect the dashboard (`/_/`)

The PocketBase dashboard is reachable on the public internet and — because it
cannot use Google SSO — is guarded by a password alone. Put one of these in front
of the `/_/` path:

* **Cloudflare Access** (Zero Trust) with a policy limited to your team's Google
  accounts. This is the least-effort option if your DNS is on Cloudflare.
* **An IP allowlist** at your proxy/load balancer.
* A **separate hostname** that is not publicly resolvable.

Failing that: a long random superuser password, and never reuse it anywhere else.

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

### Accounts and passwords (rotation)

Remember there are **two independent systems** (see 3c). Check both before
assuming a rotation is complete:

| System | How to change the credential |
|---|---|
| **Agent** (`users`) | Dashboard `/_/` → Collections → users → the record. Or the app's Settings → People. Irrelevant if password auth is disabled — agents then use Google. |
| **Superuser** (`_superusers`) | Dashboard `/_/` → **Superusers** → edit → change password. Or the API (below). |

Express check that a password is really dead — both layers, since a 200 means it
still authenticates:

```bash
for coll in users _superusers; do
  curl -s -o /dev/null -w "$coll -> %{http_code}\n" \
    -X POST "https://<your-domain>/api/collections/$coll/auth-with-password" \
    -H 'Content-Type: application/json' \
    -d '{"identity":"you@example.com","password":"OLD-PASSWORD"}'
done
```

`200` = still valid · `400` = wrong password · `403` = password auth disabled for
that collection (expected on `users` in a Google-only setup).

Changing a superuser password via the API (needs an existing superuser token):

```bash
curl -X PATCH "https://<your-domain>/api/collections/_superusers/records/<id>" \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"oldPassword":"<current>","password":"<new>","passwordConfirm":"<new>"}'
```

> ⚠️ **`MAILBOX_ADMIN_EMAIL` / `MAILBOX_ADMIN_PASSWORD` are first-boot only.** The
> bootstrap is create-if-missing and runs once, so **editing them in `.env` does
> nothing to an existing superuser** — it will not reset a password. If you have
> rotated a superuser password, update the env value too, so that a future deploy
> against a **fresh data volume** does not recreate the account with the old one.

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
docker compose pull              # fetch the new :latest image
docker compose up -d             # recreate; migrations apply on boot
```

To pin instead of tracking `:latest`, set the `image:` in `docker-compose.yml` to
a commit SHA tag — every build publishes `ghcr.io/wannaco/gw-mailbox:<sha>`.

Changing `MAILBOX_PUBLIC_URL` later is fine — it's re-applied on every boot.
Never change `PB_ENCRYPTION_KEY` after data exists.

### Logs / health

```bash
docker compose logs -f app
curl -s https://<domain>/api/health
```

---

## 6. arm64 / other architectures

The published image is **linux/amd64 only**, because the PocketBase binary
committed to the repo is linux/amd64. On an arm64 host (Hetzner Ampere, Oracle
Ampere, Graviton, Raspberry Pi, Apple-silicon Docker) the published image will
not run — build from source instead:

```bash
git clone https://github.com/wannaco/gw-mailbox.git && cd gw-mailbox
cp .env.example .env && $EDITOR .env

docker build --build-arg \
  PB_BINARY_URL=https://github.com/pocketbase/pocketbase/releases/download/v0.39.0/pocketbase_0.39.0_linux_arm64.zip \
  -t gw-mailbox:arm64 .
```

Then point the compose file at your local build by replacing the `image:` line
with `build: { context: . }` (the `pull_policy` line can stay).

Publishing a multi-arch image would need one CI job per architecture —
`build-push-action` takes a single `build-args` value for all platforms, so the
per-arch `PB_BINARY_URL` has to be a separate job rather than a matrix.

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
| Changed `MAILBOX_ADMIN_PASSWORD`, but the old admin password still works | expected — the bootstrap is first-boot only and never updates an existing superuser. Change it in the dashboard/API (see *Accounts and passwords*). |
| Rotated the agent password but the admin login still works (or vice versa) | you changed the *other* account system — `users` and `_superusers` are separate records. Check both. |
| `auth-with-password` returns 403 for every user | password auth is disabled on the `users` collection (correct for a Google-only setup) |
| Demo accounts (`alice@demo.local`) cannot sign in | they are password logins; they cannot work when password auth is off |
| Customer survey links point at the wrong host | `MAILBOX_PUBLIC_URL` not set (it drives `appURL` + link base) |
| Deploy did nothing / old UI | asset cache (`max-age=14400`) — hard-refresh (Cmd/Ctrl+Shift+R) |
