# gw-mailbox — Feature Summary

> Multi-agent **shared team inbox + kanban** on Google Workspace (Gmail).
> Backend: PocketBase 0.39 + JS `pb_hooks` (Gmail API via service account / domain-wide delegation).
> Frontend: Svelte 5, Material-3 token palette currently refined toward a **Linear-style** aesthetic (Inter font, 6–8px radii, hairline borders, underline tabs).
> Single-container deploy via Dokploy (Dockerfile builds the SPA, serves it from PocketBase `pb_public`).

## Core data model
- `inboxes` — mailboxes; per-inbox agent access via `allowed_users` / `allowed_teams`
- `threads` — conversations; **7 fixed statuses**: `new · in_progress · waiting_customer · escalated · closed · archived · spam`
- `messages` — real email + internal notes (`is_internal_note`)
- Agents = `users` auth collection; Admins = `_superusers`
- `labels` (catalog), `canned_responses`, `csat_feedback`, `contacts`, presence collections, `app_settings` config singleton

## Sync & ingestion
- **Poll sync** (every minute, toggle in Settings) and **Pub/Sub watch / webhook**; incremental from a persisted Gmail `history_id` cursor
- **Setup-time import choice** on *Add mailbox*: **"Import existing mail on setup" defaults OFF** — a fresh mailbox only receives NEW mail (history cursor jumps to "now"); ticking it pulls existing Gmail history in the background (paged, resumable stepper). Existing mailboxes untouched; per-mailbox "Backfill history" UI was removed by request (setup-time choice only)
- **Inbound attachments**: real file attachments downloaded from Gmail and stored (downloadable in-thread); inline images / signature logos excluded
- **Encoding correctness**: outbound headers RFC 2047–encoded (Subject/names), RFC 2047 decode + mojibake guard at ingest — fixed a send-side corruption bug that mangled accents/emoji (e.g. `café ☕`)
- **Message ordering** fixed: sent replies used to sort to the top on an empty `msg_date`; now real timestamps everywhere + undated messages always sort last

## Views
- **List view** (Gmail-style): search, status / assignee / label info, SLA chips, unread + message counts, per-row **⋯ quick actions** (assignee, labels), **bulk bar** (multi-select → close / archive / spam / delete, select-all-matching), compact mobile rows
- **Kanban board**: status columns, drag & drop, search, **Select mode** + bulk actions, **show/hide columns** (per-user, persisted to localStorage)
- **Thread drawer** (right panel): conversation (HTML + notes), attachments, recipients / reply-all + cc, **live signature** (Gmail-style, editable/removable), canned `/` responses, presence / composing indicators, contact panel, CSAT strip, status control

## Workflow features
- **Statuses + Escalated** across list / board / bulk; `escalated` is a real column and the SLA breach destination
- **SLA**: `sla_due_at` per ticket anchored to the real message date; chips on **New + In progress** (green on-track → amber due-soon → red pulsing overdue); hourly **breach monitor escalates** → `escalated` + ⏰ internal note + webhook; Settings enable/hours; manual "run monitor now" admin endpoint
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

## Auth & accounts
Agent password + **admin** (superuser) auth; **Google OAuth** via PocketBase OAuth2 (PKCE popup) — appears automatically when a Google provider is configured; modern two-pane login. Custom Google-branded "Sign in with Google" button to be finalized with naming/branding.

## Signatures (per-user)
Self-edit via **My profile**; admins can set on agents' behalf (Settings → People) and have their own. **Auto-insert live in the editor** (Gmail-style marker block, WYSIWYG, no duplicates, delete-sticks) + manual ✍️ button.

## Not built / deferred
- Customer-facing "where's my ticket" portal
- Cross-channel (Chatwoot / WhatsApp / Telegram into the queue)
- Google Contacts (People API) backup push — needs extra DWD scope
- Inline image paste in replies (scoped; deferred)
- Mobile OS push via ntfy / PWA (recommended: ntfy; deferred)
- Teams management UI; restore-from-spam; per-mailbox column customization (labels chosen instead)
- **Naming / branding**: not chosen. Must avoid Gmail / Google / Inbox marks; candidates discussed: Teamlane, Postboard, Coverdesk, ReplyDeck, …

## Repo / deploy notes
- `pb_migrations/` schema + seed; `pb_hooks/` backend (helpers, gmail_engine, presence_api, settings_engine, automations_engine, csat_engine, cron_engine, reports_engine, notifications_engine)
- `frontend/` Svelte 5 app (self-hosted Inter via @fontsource)
- Dokploy: push to `main` → auto-build + deploy (`mailbox.thinkcloud.dev`); assets served with `cache-control: max-age=14400` → hard-refresh after deploys
- This PocketBase fork has **no `created`/`updated` fields** — never sort PB queries by `+created` (throws); verify cron features empirically (e.g. manual SLA-monitor trigger), don't trust logs alone
