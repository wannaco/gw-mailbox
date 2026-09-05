# gw-mailbox — PocketBase Schema & API Rules

Source of truth: [`pb_migrations/1786000000_init_mailbox_schema.js`](../pb_migrations/1786000000_init_mailbox_schema.js)
Runtime target: PocketBase 0.39.x (`pocketbase --version` in this repo).

## Collection map

```
users (auth) ──< allowed_users        inboxes (base) 1─n threads (base) 1─n messages (base)
     │                                    │  ^                              │
     │  members (relation)                │  │ allowed_teams                │ thread (cascade)
     └──────────< teams (base) >──────────┘                                │
                                                                           thread (cascade)
                                                                           thread_presence (base)
```

| Collection       | Type | Purpose |
|------------------|------|---------|
| `users`          | auth | Agents (login identity, avatar, `googleEmail`, `timezone`) |
| `teams`          | base | Groups of agents; grants inbox access via `inboxes.allowed_teams` |
| `inboxes`        | base | A shared Gmail mailbox / queue ("Support", "Sales"…) |
| `threads`        | base | Ticket = Kanban card, one per Gmail thread |
| `messages`       | base | Email items **and** internal team notes (shared stream) |
| `thread_presence`| base | Ephemeral heartbeats for collision detection / draft locks |

## 1. `users` (auth)

| Field        | Type    | Notes                                  |
|--------------|---------|----------------------------------------|
| name         | text    |                                        |
| email        | email   | required, unique index                 |
| avatarUrl    | url     |                                        |
| googleEmail  | email   | agent's own GWS identity (optional)    |
| timezone     | text    | UI default                             |
| title        | text    | e.g. "Support Tier 2"                  |

Rules:

| Rule       | Expression                          |
|------------|-------------------------------------|
| list/view  | `@request.auth.id != ""`            |
| create     | `null` (provisioned by superuser)   |
| update     | `@request.auth.id = id`             |
| delete     | `null`                              |
| authRule   | `""` (email+password login enabled) |

## 2. `teams` (base)

| Field       | Type     | Notes                              |
|-------------|----------|------------------------------------|
| name        | text     | required                           |
| description | text     |                                    |
| members     | relation→users (multiple) | maxSelect 1000 |

Rules: list/view `members ~ @request.auth.id`; create/update/delete `null`.

## 3. `inboxes` (queues)

| Field          | Type     | Notes                                       |
|----------------|----------|---------------------------------------------|
| name           | text     | required                                    |
| email_address  | email    | required, **unique index**                  |
| allowed_users  | relation→users (multiple) | direct grants             |
| allowed_teams  | relation→teams (multiple) | grant via team membership |
| history_id     | text     | Gmail watch sync cursor                     |
| is_active      | bool     | soft disable                                |

Read rule (the permission root of the whole app — everything funnels here):

```
list/view:
  @request.auth.id != "" &&
  is_active = true &&
  (allowed_users ~ @request.auth.id ||
   allowed_teams.members ~ @request.auth.id)
```

create/update/delete: `null` (admin-provisioned; internal pb_hooks writes bypass rules).

## 4. `threads` (tickets / Kanban cards)

| Field             | Type     | Notes                                        |
|-------------------|----------|----------------------------------------------|
| inbox             | relation→inboxes | required, cascade on inbox delete  |
| gmail_thread_id   | text     | required, **unique index**                   |
| subject           | text     |                                              |
| snippet           | text     | Gmail snippet                                |
| customer_email    | email    | external party (indexed)                     |
| customer_name     | text     |                                              |
| status            | select   | `new`, `in_progress`, `waiting_customer`, `escalated`, `closed` |
| assigned_agent    | relation→users | single, optional                    |
| tags              | json     | e.g. `["urgent","billing"]`                  |
| last_message_at   | date     | customer traffic timestamp (Kanban sort)     |
| sla_due_at        | date     | set by hook: `now + MAILBOX_SLA_HOURS` (24)  |
| calendar_event_id | text     | link to Google Calendar event (1-click Meet) |

Read/update rule:

```
list/view/update:
  @request.auth.id != "" &&
  (inbox.allowed_users ~ @request.auth.id ||
   inbox.allowed_teams.members ~ @request.auth.id)
```

create: `null` (only the Gmail ingest engine creates cards),
delete: `null`.

Hooks: `onRecordBeforeCreate` forces `status="new"` and fills `sla_due_at`
when missing.

## 5. `messages` (items & notes)

| Field             | Type     | Notes                                       |
|-------------------|----------|---------------------------------------------|
| thread            | relation→threads | required, **cascade delete**     |
| gmail_message_id  | text     | **partial unique index** (`!= ''`) — internal notes share the empty value |
| sender_email      | email    |                                            |
| recipient_emails  | json     | array of addresses                         |
| body_html         | text     | max 2 MB                                   |
| body_plain        | text     | max 2 MB                                   |
| is_internal_note  | bool     | private team @mention notes                |

Rules: list/view funnel through `thread.inbox.*` (same as threads);
create/update/delete `null` — all writes are server-side (webhook ingest +
`POST /api/mailbox/threads/{id}/notes`).

## 6. `thread_presence` (ephemeral)

| Field       | Type     | Notes                                        |
|-------------|----------|----------------------------------------------|
| thread      | relation→threads | required, cascade delete            |
| user        | relation→users   | required                            |
| status      | select   | `viewing`, `composing_reply` (required)      |
| updated_at  | date     | heartbeat timestamp (server-set, not client) |

Rules:

```
list/view:
  @request.auth.id != "" &&
  (thread.inbox.allowed_users ~ @request.auth.id ||
   thread.inbox.allowed_teams.members ~ @request.auth.id)

create/update/delete:
  @request.auth.id != "" && user = @request.auth.id
```

Cross-agent reads are allowed on purpose — that is how Agent B learns that
Agent A is `composing_reply` and disables the reply composer.

Indexes: `(thread,user)` for upsert lookups, `updated_at` for the sweeper.

## Realtime semantics

PocketBase broadcasts every record create/update/delete on `/api/realtime`
(subscriptions: `threads`, `messages`, `thread_presence`, `inboxes`) and
enforces each collection's `listRule` per connected client — so:

- an agent only receives SSE events for threads/messages/presence of inboxes
  they can read (the funnel rules above);
- a presence heartbeat = one small record update = one SSE event ≈ draft-lock
  banner updates across the team with no custom pub/sub code;
- card drags are ordinary `PATCH threads/{id}` updates (`updateRule` permits)
  that every board client receives and reorders.
