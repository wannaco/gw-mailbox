# gw-mailbox — Google Workspace Collaborative Mailbox & Kanban (PocketBase)

High-performance, real-time shared email inbox + collaborative Kanban ticketing
for Google Workspace. Backend: **PocketBase 0.39.x** (SQLite + SSE realtime +
Cron + JS hooks, zero external services). External calls: **Gmail API v3**
(Pub/Sub push webhooks) and **Google Calendar API v3**.

```
┌──────────────┐  push   ┌──────────────────────────────────────────────┐
│ Google       │ ──────► │ PocketBase  (this repo)                       │
│ Pub/Sub      │  /api/  │  pb_hooks/gmail.pb.js   → threads + messages  │
│  (Gmail)     │  gmail- │  pb_hooks/calendar.pb.js→ Meet booking        │
└──────────────┘  webhook│  pb_hooks/main.pb.js    → presence/draft-lock │
                         │  pb_hooks/cron.pb.js    → SLA + sweeper jobs  │
                         │  /api/realtime (SSE)    → live board/panes    │
                         └──────────────────────────────────────────────┘
                                  ▲                    │  /api/collections/*
                                  │  SSE + REST        │  + /api/mailbox/*
                           ┌──────┴──────┐      ┌──────▼──────┐
                           │ Agent A     │      │ Agent B     │  (M3 frontend, Phase 3)
                           └─────────────┘      └─────────────┘
```

## Repository layout

```
pb_migrations/1786000000_init_mailbox_schema.js   Phase 1 — schema + rules
pb_hooks/
  main.pb.js           registrar: presence/notes/move routes + record hooks
  gmail.pb.js          registrar: webhook + watch/sync routes
  calendar.pb.js       registrar: availability/meet routes
  cron.pb.js           registrar: SLA monitor + presence sweeper jobs
  lib/
    helpers.js         shared: cors/auth, access checks, presence engine,
                       Google SA auth (signer/openssl), dates, base64, notes
    presence_api.js    presence heartbeat/lock, notes, move, me handlers
    gmail_engine.js    Pub/Sub webhook, watch, history-sync engine
    calendar_engine.js free/busy + 1-click Meet booking
    cron_engine.js     SLA breach monitor + stale presence sweeper
scripts/signer/        RS256 JWT signer sidecar (Go)
scripts/e2e.py         end-to-end suite (schema → presence → notes → SSE)
docs/schema.md         collection/field/rules reference
.env.example           configuration template
pocketbase             PB 0.39 binary
```

## Quick start (dev)

```bash
cd gw-mailbox
cp .env.example .env            # fill GOOGLE_SA_FILE / GOOGLE_PUBSUB_TOPIC
go run ./scripts/signer &       # optional — openssl fallback exists
./pocketbase serve --http=127.0.0.1:8090 --dev
```

First boot runs the migration (creates `users`, `teams`, `inboxes`, `threads`,
`messages`, `thread_presence` + indexes + rules). Then:

1. Open `http://127.0.0.1:8090/_/` → create the superuser.
2. Provision inboxes (Admin UI or REST as superuser):
   ```json
   POST /api/collections/inboxes/records
   { "name": "Support", "email_address": "support@yourdomain.com",
     "allowed_users": ["<agent-user-id>"], "allowed_teams": ["<team-id>"], "is_active": true }
   ```
3. Start the Gmail push watch:
   ```bash
   curl -X POST http://127.0.0.1:8090/api/mailbox/inboxes/{inboxId}/watch \
     -H "Authorization: Bearer <agent-token>"
   ```
   (requires the Pub/Sub topic to exist and a push subscription pointing at
   `https://<host>/api/gmail-webhook` — see *Webhook setup*.)
4. Watch the SSE stream:
   ```bash
   curl -N http://127.0.0.1:8090/api/realtime \
     -H "Authorization: Bearer <agent-token>"
   ```
   subscribe: `{"clientId":"x","subscriptions":["threads","messages","thread_presence","inboxes"]}`

## Custom API surface (everything else is plain PocketBase REST + realtime)

| Method | Route | Purpose |
|--------|-------|---------|
| GET  | `/api/mailbox/me` | agent profile + permitted inboxes (UI bootstrap) |
| POST | `/api/mailbox/threads/{id}/presence` | heartbeat `{status: viewing\|composing_reply}` → returns `lock` when another agent is drafting |
| GET  | `/api/mailbox/threads/{id}/presence` | current viewers/composers |
| DELETE | `/api/mailbox/threads/{id}/presence` | release lock |
| POST | `/api/mailbox/threads/{id}/notes` | internal note `{body}` (@mentions) |
| POST | `/api/mailbox/threads/{id}/move` | validated status/assignee/tags move |
| POST | `/api/mailbox/inboxes/{id}/watch` | register Gmail push watch |
| POST | `/api/mailbox/inboxes/{id}/sync` | incremental sync (`?backfill=1` full) |
| GET  | `/api/gmail-webhook` | probe |
| POST | `/api/gmail-webhook` | Google Pub/Sub push |
| GET  | `/api/mailbox/threads/{id}/availability?start&end` | free/busy + suggested slots |
| POST | `/api/mailbox/threads/{id}/meet` | book Meet `{start,end,summary?}` → links event, internal note, status→`waiting_customer` |
| POST | `/api/mailbox/threads/{id}/cancel-meet` | remove linked event |

Frontend consumption notes (Phase 3):

- **Kanban board**: `GET /api/collections/threads/records?filter=(inbox='..')&sort=-last_message_at`
  + SSE on `threads` for live drag/drop; drag = `PATCH /api/collections/threads/{id}` `{status}` or the `/move` endpoint.
- **Thread detail**: expand `thread.inbox`, list
  `GET /api/collections/messages/records?filter=(thread='..')`, compose tab
  toggles `presence` heartbeat to `composing_reply`.
- **Draft lock**: subscribe `thread_presence`; when a *different* `user` row has
  `status=composing_reply`, show the M3 banner and disable Reply/Meet.

## Webhook setup (Gmail push)

1. Create topic + subscription (Pub/Sub Admin API):
   - topic: `projects/{project}/topics/{topic}` → use `users.watch` with it.
   - subscription: push endpoint `https://<public-host>/api/gmail-webhook`.
     Recommended: enable **OIDC token** with `audience` = your webhook URL and
     verify the JWT server-side (certs at
     `https://www.googleapis.com/oauth2/v1/certs`). For quick setups set
     `MAILBOX_WEBHOOK_SECRET` and send `X-Mailbox-Webhook-Token`.
2. Grant the service account the Gmail scopes for every mailbox address that
   will be an inbox (`gmail.modify`, `calendar.events`), enabled via
   domain-wide delegation in the Workspace Admin console.
3. Call `POST /api/mailbox/inboxes/{id}/watch`.

## Cron automations (`pb_hooks/cron.pb.js`)

| Job | Schedule | Action |
|-----|----------|--------|
| `gw-sla-monitor` | hourly (`0 * * * *`) | `status="new" && sla_due_at <= now` → `escalated`, internal note, `MAILBOX_ALERT_WEBHOOK` alert |
| `gw-presence-sweeper` | every minute (`* * * * *`) | deletes `thread_presence` heartbeats older than 2 min (no phantom draft locks) |

## Implementation phases

1. **Phase 1 — Schema & rules** ✅ `pb_migrations/…` + `docs/schema.md`
2. **Phase 2 — Gmail webhook + Calendar hooks** ✅ `gmail.pb.js`, `calendar.pb.js`
3. **Phase 3 — M3 frontend** ⏳ SvelteKit/React + Material 3 (nav rail, kanban
   DnD, thread viewer w/ notes tab) — consumes the REST + SSE contract above.
4. **Phase 4 — SSE bindings** ✅ backend already emits; Phase 3 wires clients.

## Frontend — Svelte 5 + Material 3 (Phase 3 slice)

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173  (/api proxied to PB :8090)
# override backend:  VITE_PB_URL=http://host:8090 npm run dev
```

Zero-framework-weight build: Svelte 5 + Vite only, **no meta-framework, no state
lib, no component library** — Material 3 via generated design tokens
(`src/m3.css`, light+dark) and ~15 hand-rolled components. Dev preview proxies
`/api` → PocketBase, so no CORS config. Production: `npm run build` (dist ≈ 26 KB
JS + 4 KB CSS gzip) and serve `dist/` behind the same host as PB (or set
`MAILBOX_ALLOWED_ORIGIN` and `VITE_PB_URL`).

Includes: M3 nav rail with inbox switcher, Kanban board (native drag between
status columns → optimistic `/move`, revert+snackbar on failure), filter chips
+ search, thread drawer with conversation/notes tabs, live presence heartbeat
(composing lock banner disables Reply/Meet while a teammate drafts), internal
notes, reply composer (`/reply`), and 1-click Meet slot booking
(`/availability` + `/meet`). Realtime = fetch-stream SSE with auth header
(`src/lib/api.js`), auto-reconnect, subscribed to `threads`/`messages`/
`thread_presence`.

Phase 3 slice verified: `npm run build` clean (26 KB JS + 4 KB CSS gzip);
dev server + proxy serves the app and completes agent login → `/mailbox/me`.

## Verified end-to-end (PocketBase 0.39 binary, `scripts/e2e.py`)

```
RESULT: 22 passed, 0 failed
```

- migration applies cleanly (PB 0.39 auto-creates `users`; the migration
  augments it idempotently with agent fields + rules)
- API rules: cross-inbox isolation via direct grants AND
  `allowed_teams.members` (Alice cannot list/view Bob's threads, and back)
- record hooks: default `status=new`, `sla_due_at = now + MAILBOX_SLA_HOURS`
- draft lock: Bob's presence heartbeat returns
  `lock.agentName = "Alice Agent"` while Alice is composing; snapshots show
  both agents; closing a card releases the composer lock
- internal notes visible to teammates on the same inbox
- card moves with assignment; webhook push acks gracefully (`200`)
- SSE: presence heartbeat → `event:thread_presence` frame to subscribers
- cron: `gw-presence-sweeper` removed a stale row at the next minute tick;
  calendar availability returns a clean 502 when Google creds are absent

## Notes / trade-offs

- PB 0.39 removed the old `rsaSign` — service-account JWTs are signed by the
  vendored Go sidecar, falling back to `openssl dgst -sha256 -sign`.
- Webhook processing is inline for simplicity; very high-volume deployments
  should enqueue history ids in a small collection and let a cron drain them.
- Access is inbox-scoped; the `users` auth collection is intentionally
  admin-provisioned (`createRule: null`).
- `messages.gmail_message_id` uses a partial unique index so internal notes
  (empty gmail id) never collide.
- Handlers live in `pb_hooks/lib/*` and are registered through inline
  `require()` wrappers because PB 0.39 does not retain closure/top-level
  scope for `routerAdd`/`cronAdd` callbacks (documented in registrar headers).

---

## Accounts, sign-in and security

### Two account systems (they are separate)

| | `users` — agents | `_superusers` — admin |
|---|---|---|
| Sign in to | the app | the PocketBase dashboard `/_/` |
| Created by | Settings → People, or the demo seed | `MAILBOX_ADMIN_*` on **first boot** |
| Google SSO | **yes** | **no — not supported by PocketBase** |
| Password | can be disabled | always on |

They are independent records and often share an email address. **Changing a
password on one does not change the other**, which is the most common source of
confusion when rotating credentials.

### Recommended setup

1. Configure the Google OAuth client and enable the **Google** provider on the
   `users` collection — see [docs/DEPLOY.md § 3b](docs/DEPLOY.md).
2. Verify Google sign-in works, then **disable password auth on `users`**:
   `/_/` → Collections → users → Auth methods → uncheck **Password**.
3. Give each agent a Google Workspace account on your own domain (that address
   maps to their user record).
4. Put **Cloudflare Access or an IP allowlist in front of `/_/`** — the dashboard
   cannot use SSO, so it is password-only and publicly reachable by default.
5. Set a strong, unique superuser password, and keep `MAILBOX_ADMIN_PASSWORD`
   in sync (it is **first-boot only** and will not reset an existing account).

### Built-in guardrails in this codebase

- Credentials are never committed: tests read `TEST_EMAIL` / `TEST_PASSWORD` from
  the environment, and the demo seed takes its password from `MAILBOX_DEMO_PASSWORD`
  (random if unset). There are no hardcoded defaults by design.
- `pb_data/` (the database), `.env` and backups are gitignored.
- **`frontend/` is not the web root** — the container serves the compiled SPA from
  `pb_public`, so source files cannot be fetched over HTTP. (Projects that serve a
  raw source directory publicly have shipped stray scripts and secrets this way.)
- **`users.role` is not self-assignable.** The app gates on it (`admin` sees
every inbox and reaches Settings; `agent` sees only the inboxes they were
granted), but `users.updateRule` is `@request.auth.id = id`, so any signed-in
user can PATCH their own record — and a PocketBase rule cannot exclude a single
field. `pb_hooks/role_guard.pb.js` therefore refuses any role change that is not
made by an admin or a superuser. **Without it an agent could promote themselves**
and read every inbox in the domain, in the same request that sets the field.
- Collection API rules restrict anonymous reads; verify with an unauthenticated
  request to `/api/collections/<name>/records` after any schema change.

> ⚠️ Do not combine `MAILBOX_SEED_DEMO=1` with Google-only sign-in: the demo
> accounts are password logins and will be unable to sign in at all.

---

## Deployment

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full guide. Quick start on any
VPS with Docker:

```bash
cp .env.example .env      # set DOMAIN, MAILBOX_PUBLIC_URL, MAILBOX_ADMIN_*
docker compose up -d --build
```

The container is domain-agnostic: the SPA is same-origin and the public URL is
read at runtime, so the same build runs on any host. On boot the app applies
migrations, sets PocketBase's `appURL` from `MAILBOX_PUBLIC_URL`, creates the
first **superuser** from `MAILBOX_ADMIN_*` **if one does not already exist**, and
(only if `MAILBOX_SEED_DEMO=1`) demo data.

Three things about that bootstrap are easy to get wrong:

- **It is create-if-missing and runs once.** Editing `MAILBOX_ADMIN_PASSWORD`
  later does not reset an existing superuser.
- It creates a **superuser** (dashboard access), *not* an app agent.
- Agents sign in separately, and should use **Google SSO** — see
  [Accounts, sign-in and security](#accounts-sign-in-and-security).

Feature overview: **[docs/FEATURES.md](docs/FEATURES.md)**.
User guide (screenshots): **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)**.

---

## Third-party software

This app is built on other people's work and ships their notices with it.
See **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** for the full license
texts.

| Component | Role | License |
|---|---|---|
| [PocketBase](https://github.com/pocketbase/pocketbase) | backend runtime (binary in this repo, baked into the image) | MIT © Gani Georgiev |
| [Svelte](https://github.com/sveltejs/svelte) | front-end framework (compiled into the bundle) | MIT © Svelte Contributors |
| [Inter](https://github.com/rsms/inter) | UI typeface, via `@fontsource/inter` | SIL OFL 1.1 |

These notices are **required to travel with the software**, so they are not just
kept in the repo — the Dockerfile bakes them into the image at
`/app/THIRD_PARTY_NOTICES.md` and into `pb_public`, which serves them at
`/THIRD_PARTY_NOTICES.txt`. The app also links to that file from the bottom of
**Settings**.

If you redistribute this app (an image, an archive, a mirror), keep those files
with it. Note that **the app's own source is not open source** — see `LICENSE`.
