# gw-mailbox — Feature Summary

> Multi-agent **shared team inbox + kanban** on Google Workspace (Gmail).
> Backend: PocketBase 0.39 + JS `pb_hooks` (Gmail API via service account / domain-wide delegation).
> Frontend: Svelte 5, Material-3 token palette currently refined toward a **Linear-style** aesthetic (Inter font, 6–8px radii, hairline borders, underline tabs).
> Single-container deploy via Dokploy (Dockerfile builds the SPA, serves it from PocketBase `pb_public`).

## Core data model
- `inboxes` — mailboxes; per-inbox agent access via `allowed_users` / `allowed_teams`
- `threads` — conversations; **7 fixed statuses**: `new · in_progress · waiting_customer · escalated · closed · archived · spam`
- `messages` — real email + internal notes (`is_internal_note`)
- Agents **and app admins** = the `users` auth collection; admin = `users.role === "admin"` (select: `agent` | `admin`)
- `_superusers` = PocketBase **infrastructure only** (dashboard `/_/`, CLI, backups). The app never authenticates against it — break-glass ops only.
- `labels` (catalog), `canned_responses`, `csat_feedback`, `contacts`, presence collections, `app_settings` config singleton

## Sync & ingestion
- **Poll sync** (every minute, toggle in Settings) and **Pub/Sub watch / webhook**; incremental from a persisted Gmail `history_id` cursor
- **Setup-time import choice** on *Add mailbox*: **"Import existing mail on setup" defaults OFF** — a fresh mailbox only receives NEW mail (history cursor jumps to "now"); ticking it pulls existing Gmail history in the background (paged, resumable stepper). The choice exists only at setup time (per-mailbox backfill UI was deliberately removed). Existing mailboxes untouched.
- **Inbound attachments**: real file attachments downloaded from Gmail and stored (downloadable in-thread); inline images / signature logos excluded
- **Encoding correctness**: outbound headers RFC 2047–encoded (Subject/names), RFC 2047 decode + mojibake guard at ingest — fixed a send-side corruption bug that mangled accents/emoji (e.g. `café ☕`)
- **Message ordering** fixed: sent replies used to sort to the top on an empty `msg_date`; now real timestamps everywhere + undated messages always sort last

## Views
- **List view** (Gmail-style): search, status / assignee / label info, SLA chips, unread + message counts, per-row **⋯ quick actions** (assignee, labels), **bulk bar** (multi-select → close / archive / spam / delete, select-all-matching), compact mobile rows
- **Kanban board**: status columns, **drag & drop between columns** (move persists server-side), search, **Select mode** + bulk actions, **show/hide columns** via the `Columns` toolbar menu (per-user, persisted to localStorage)
- **Thread drawer** (right panel): conversation (HTML + notes), attachments, recipients / reply-all + cc, **live signature** (Gmail-style, editable/removable), canned `/` responses, presence / composing indicators, contact panel, CSAT strip, status control

## Workflow features
- **Statuses + Escalated** across list / board / bulk; `escalated` is a real column and the SLA breach destination
- **SLA**: `sla_due_at` per ticket anchored to the real **message date** (not import time); chips on **New + In progress** (green on-track → amber due-soon → red pulsing overdue); hourly **breach monitor** scans new + in-progress and **escalates** breaches → `escalated` + ⏰ internal note + webhook; Settings enable/hours; **manual "run monitor now"** admin endpoint (`POST /api/mailbox/admin/run-sla-monitor`)
- **Follow-up automations**: configurable nudge sequence (delay / interval / max) + auto-close, cron-driven
- **Contacts**: auto-upsert from inbound mail; editable panel + tags; **Related cases** (same customer) in drawer
- **CSAT**: opt-in (Settings, **default off**); on ticket close emails a unique public link `/csat/<token>` (no login) → star rating + comment stored per ticket, visible in drawer; re-close after response sends a fresh survey; duplicate submissions blocked
- **Meet scheduler**: Google Calendar availability + event creation from a thread (service account)
- **Canned responses / placeholders**: `/command` insert; fills `{{customer_name}}`, `{{customer_email}}`, `{{subject}}`, `{{inbox}}`; unknown tokens stay literal
- **Labels & categories**: admin catalog; per-ticket tags; label filtering. (Sales "column renaming" deliberately not built — handled via labels by user decision)
- **Quick actions** on list rows: assign / label without opening the thread (canned send-from-row removed — threading issues)

## Collaboration & realtime
- Agent **presence / roster** (online, composing) + composing locks
- **@mentions** with mentionable admins; in-app notification bell; **OS notifications** for mentions/notes on backgrounded tabs
- Cross-session convergence: ~10s quiet list re-sync, refresh-on-tab-focus, optimistic local updates after moves/bulk

## Reports
Stat cards: Open · Closed · SLA overdue · Avg CSAT · **Avg 1st response** · **Avg resolution** (arrival → first agent reply / arrival → close, human durations). By-status bars, per-inbox volume, Agents table (open / closed / total / **1st replies**). Going-forward `first_response_at` / `closed_at` stamping feeds the time metrics.

## Settings (admin; tabs: Connection / Mailboxes / Content / Automation / People)
Google service-account key + connection test + poll toggle; mailbox management (incl. the import choice + per-mailbox agents); labels & canned responses; SLA + follow-up automation config; mention prefs; **Agents & signatures**; CSAT enable. Config read/written via backend engine; SLA/CSAT also on `/me` for agent UI.

## Auth, accounts & roles
- **One login for everyone.** No separate admin sign-in: the app authenticates only against `users`.
- **Roles:** `users.role` (`agent` | `admin`, default `agent`) — migration `1786000026_app_roles.js`. Every `_superusers` record was auto-mirrored to a `users` row with `role = "admin"` so admins are ordinary app users (SSO works, assignable, one signature path). Backend gates Settings/mailbox/report routes on `role === "admin"` (`requireAdmin`).
- **Why:** the old design reused `_superusers` as the app's admin, which meant a *root DB token stored in browser localStorage*, no SSO for admins (PocketBase disables OAuth2 on system collections), duplicated signature schemas and ~22 `isSuperuser` special-cases.
- **Google OAuth** via PocketBase OAuth2 (PKCE popup) — live; the "Continue with Google" button appears automatically when a Google provider is configured.
- ⚠️ **Gap:** there is **no UI to promote/demote** a user — `role` is currently editable only via the PocketBase dashboard (`/_/`) or API (a Settings → People toggle is an obvious future addition).
- ⚠️ Note: the `app_roles` migration created each admin's `users` record with a **random throwaway password** — admins sign in with Google, or an admin sets a real password from the app.

## Signatures (per-user)
Self-edit via **My profile**; admins can set on agents' behalf (Settings → People) and have their own. **Auto-insert live in the editor** (Gmail-style marker block, WYSIWYG, no duplicates, delete-sticks) + manual ✍️ button.

## UI / design
Material-3 token palette refined toward a **Linear-style** aesthetic (see `ui polish pass 1–4` commits): **Inter** (self-hosted via `@fontsource`) across the type scale, **6–8px radii** instead of pills, hairline borders, quiet chrome (white topbar/nav rail), underline Settings tabs, elevated white cards on the board, and consistent focus rings. Screenshots: `docs/screenshots/`.

## Not built / deferred
- Customer-facing "where's my ticket" portal
- Cross-channel (Chatwoot / WhatsApp / Telegram into the queue)
- Google Contacts (People API) backup push — needs extra DWD scope
- Inline image paste in replies (scoped; deferred)
- Mobile OS push via ntfy / PWA (recommended: ntfy; deferred)
- **Admin role toggle in the UI** (promote/demote `users.role`) — currently dashboard/API only
- Teams management UI; restore-from-spam; per-mailbox column customization (labels chosen instead)
- **Naming / branding**: not chosen. Must avoid Gmail / Google / Inbox marks; candidates discussed: Teamlane, Postboard, Coverdesk, ReplyDeck, …

## Repo / deploy notes
- `pb_migrations/` schema + seed; `pb_hooks/` backend (helpers, gmail_engine, presence_api, settings_engine, automations_engine, csat_engine, cron_engine, reports_engine, notifications_engine)
- `frontend/` Svelte 5 app (self-hosted Inter via @fontsource)
- Dokploy: push to `main` → auto-build + deploy (`mailbox.thinkcloud.dev`); assets served with `cache-control: max-age=14400` → hard-refresh after deploys
- This PocketBase fork has **no `created`/`updated` fields** — never sort PB queries by `+created` (throws); verify cron features empirically (e.g. manual SLA-monitor trigger), don't trust logs alone
