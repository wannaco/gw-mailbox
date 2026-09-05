/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — Phase 1: Schema + API security rules
//
// Collections:
//   users            (auth)  — agents. NOTE: PB 0.39 auto-creates a default
//                               `users` auth collection on fresh installs, so
//                               we AUGMENT it (extra fields + rules) rather
//                               than recreate it.
//   teams            (base)  — groups referenced by inboxes.allowed_teams
//   inboxes          (base)  — Gmail shared mailbox / queue
//   threads          (base)  — ticket / Kanban card
//   messages         (base)  — email items + internal notes
//   thread_presence  (base)  — ephemeral collision-detection heartbeats
//
// Design notes:
//   * Permission root is the INBOX. Every rule funnels through
//     `inbox.allowed_users` (direct) OR `inbox.allowed_teams.members`.
//   * Superusers bypass rules, so provisioning happens from the Admin UI.
//   * Server-side writes from pb_hooks never evaluate API rules, so the
//     ingest / cron / calendar engines are unaffected by closed rules.
//   * Field additions use FieldsList.addMarshaledJSON() — plain-object
//     .fields.add({...}) does NOT convert to core.Field in the JS runtime.
// =============================================================================
migrate((app) => {
  // -------------------------------------------------------------------------
  // 0. users (auth) — create if absent, otherwise augment in place
  // -------------------------------------------------------------------------
  let users;
  try {
    users = app.findCollectionByNameOrId("users");
  } catch (_) {
    users = new Collection({
      name: "users",
      type: "auth",
      fields: [
        { name: "name", type: "text", max: 200 },
        { name: "email", type: "email", required: true }
      ]
    });
  }

  // Extra agent profile fields (added when missing so this stays idempotent).
  const ensureField = (coll, fieldObj) => {
    if (!coll.fields.getByName(fieldObj.name)) {
      coll.fields.addMarshaledJSON(JSON.stringify([fieldObj]));
    }
  };
  ensureField(users, { name: "googleEmail", type: "email" });
  ensureField(users, { name: "timezone", type: "text", max: 64 });
  ensureField(users, { name: "title", type: "text", max: 200 });

  users.listRule = '@request.auth.id != ""';
  users.viewRule = '@request.auth.id != ""';
  users.createRule = null;                              // admin-provisioned
  users.updateRule = '@request.auth.id = id';           // agents edit self
  users.deleteRule = null;
  users.authRule = "";                                  // email+password login
  app.save(users);

  // -------------------------------------------------------------------------
  // 1. teams (base)
  // -------------------------------------------------------------------------
  let teams;
  try {
    teams = app.findCollectionByNameOrId("teams");
  } catch (_) {
    teams = new Collection({
      name: "teams",
      type: "base",
      fields: [
        { name: "name", type: "text", required: true, max: 200 },
        { name: "description", type: "text", max: 1000 }
      ]
    });
    teams.listRule = '@request.auth.id != "" && members ~ @request.auth.id';
    teams.viewRule = '@request.auth.id != "" && members ~ @request.auth.id';
    teams.createRule = null;
    teams.updateRule = null;
    teams.deleteRule = null;
  }
  ensureField(teams, { name: "members", type: "relation", collectionId: users.id, maxSelect: 1000 });
  app.save(teams);

  // -------------------------------------------------------------------------
  // 2. inboxes (queues)
  // -------------------------------------------------------------------------
  let inboxes;
  try {
    inboxes = app.findCollectionByNameOrId("inboxes");
  } catch (_) {
    inboxes = new Collection({
      name: "inboxes",
      type: "base",
      fields: [
        { name: "name", type: "text", required: true, max: 200 },
        { name: "email_address", type: "email", required: true },
        { name: "history_id", type: "text", max: 64 },
        { name: "is_active", type: "bool" }
      ]
    });
  }
  ensureField(inboxes, { name: "allowed_users", type: "relation", collectionId: users.id, maxSelect: 1000 });
  ensureField(inboxes, { name: "allowed_teams", type: "relation", collectionId: teams.id, maxSelect: 1000 });

  const CAN_VIEW_INBOX =
    '@request.auth.id != "" && is_active = true && ' +
    '(allowed_users ~ @request.auth.id || allowed_teams.members ~ @request.auth.id)';
  inboxes.listRule = CAN_VIEW_INBOX;
  inboxes.viewRule = CAN_VIEW_INBOX;
  inboxes.createRule = null;
  inboxes.updateRule = null;
  inboxes.deleteRule = null;
  app.save(inboxes);

  // -------------------------------------------------------------------------
  // 3. threads (tickets / kanban cards)
  // -------------------------------------------------------------------------
  let threads;
  try {
    threads = app.findCollectionByNameOrId("threads");
  } catch (_) {
    threads = new Collection({
      name: "threads",
      type: "base",
      fields: [
        { name: "subject", type: "text", max: 2000 },
        { name: "snippet", type: "text", max: 5000 },
        { name: "customer_email", type: "email" },
        { name: "customer_name", type: "text", max: 300 },
        {
          name: "status",
          type: "select",
          maxSelect: 1,
          values: ["new", "in_progress", "waiting_customer", "escalated", "closed"]
        },
        { name: "tags", type: "json", maxSize: 200000 },
        { name: "last_message_at", type: "date" },
        { name: "sla_due_at", type: "date" },
        { name: "calendar_event_id", type: "text", max: 300 }
      ]
    });
  }
  ensureField(threads, { name: "inbox", type: "relation", collectionId: inboxes.id, maxSelect: 1, required: true, cascadeDelete: true });
  ensureField(threads, { name: "gmail_thread_id", type: "text", max: 300, required: true });
  ensureField(threads, { name: "assigned_agent", type: "relation", collectionId: users.id, maxSelect: 1 });

  const CAN_VIEW_THREAD =
    '@request.auth.id != "" && ' +
    '(inbox.allowed_users ~ @request.auth.id || inbox.allowed_teams.members ~ @request.auth.id)';
  threads.listRule = CAN_VIEW_THREAD;
  threads.viewRule = CAN_VIEW_THREAD;
  threads.createRule = null;              // only the ingest engine creates cards
  threads.updateRule = CAN_VIEW_THREAD;   // agents move cards / assign / tag
  threads.deleteRule = null;
  app.save(threads);

  // -------------------------------------------------------------------------
  // 4. messages (email items & internal notes)
  // -------------------------------------------------------------------------
  let messages;
  try {
    messages = app.findCollectionByNameOrId("messages");
  } catch (_) {
    messages = new Collection({
      name: "messages",
      type: "base",
      fields: [
        { name: "sender_email", type: "email" },
        { name: "recipient_emails", type: "json", maxSize: 200000 },
        { name: "body_html", type: "text", max: 2000000 },
        { name: "body_plain", type: "text", max: 2000000 },
        { name: "is_internal_note", type: "bool" }
      ]
    });
  }
  ensureField(messages, { name: "thread", type: "relation", collectionId: threads.id, maxSelect: 1, required: true, cascadeDelete: true });
  ensureField(messages, { name: "gmail_message_id", type: "text", max: 300 });

  const CAN_VIEW_MESSAGE =
    '@request.auth.id != "" && ' +
    '(thread.inbox.allowed_users ~ @request.auth.id || thread.inbox.allowed_teams.members ~ @request.auth.id)';
  messages.listRule = CAN_VIEW_MESSAGE;
  messages.viewRule = CAN_VIEW_MESSAGE;
  messages.createRule = null;             // server engine writes only
  messages.updateRule = null;
  messages.deleteRule = null;
  app.save(messages);

  // -------------------------------------------------------------------------
  // 5. thread_presence (ephemeral collision detection)
  // -------------------------------------------------------------------------
  let presence;
  try {
    presence = app.findCollectionByNameOrId("thread_presence");
  } catch (_) {
    presence = new Collection({
      name: "thread_presence",
      type: "base",
      fields: [
        {
          name: "status",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["viewing", "composing_reply"]
        },
        { name: "updated_at", type: "date" }
      ]
    });
  }
  ensureField(presence, { name: "thread", type: "relation", collectionId: threads.id, maxSelect: 1, required: true, cascadeDelete: true });
  ensureField(presence, { name: "user", type: "relation", collectionId: users.id, maxSelect: 1, required: true });

  const CAN_VIEW_PRESENCE =
    '@request.auth.id != "" && ' +
    '(thread.inbox.allowed_users ~ @request.auth.id || thread.inbox.allowed_teams.members ~ @request.auth.id)';
  presence.listRule = CAN_VIEW_PRESENCE;  // cross-agent visibility (draft lock)
  presence.viewRule = CAN_VIEW_PRESENCE;
  presence.createRule = '@request.auth.id != "" && user = @request.auth.id';
  presence.updateRule = '@request.auth.id != "" && user = @request.auth.id';
  presence.deleteRule = '@request.auth.id != "" && user = @request.auth.id';
  app.save(presence);

  // -------------------------------------------------------------------------
  // Indexes (uniqueness + hot query paths)
  // -------------------------------------------------------------------------
  const addIndexIfMissing = (coll, name, unique, colsExpr, whereExpr) => {
    if (!coll.getIndex(name)) {
      coll.addIndex(name, unique, colsExpr, whereExpr || "");
    }
  };

  addIndexIfMissing(inboxes, "idx_inboxes_email", true, "email_address");
  addIndexIfMissing(threads, "idx_threads_gmail_thread", true, "gmail_thread_id");
  addIndexIfMissing(threads, "idx_threads_inbox", false, "inbox");
  addIndexIfMissing(threads, "idx_threads_status", false, "status");
  addIndexIfMissing(threads, "idx_threads_assigned", false, "assigned_agent");
  addIndexIfMissing(threads, "idx_threads_last_message", false, "last_message_at");
  // Partial unique: internal notes (no gmail id) share the empty string safely.
  addIndexIfMissing(messages, "idx_messages_gmail_msg", true, "gmail_message_id", "gmail_message_id != ''");
  addIndexIfMissing(messages, "idx_messages_thread", false, "thread");
  addIndexIfMissing(presence, "idx_presence_thread_user", false, "thread, user");
  addIndexIfMissing(presence, "idx_presence_updated", false, "updated_at");

  app.save(inboxes);
  app.save(threads);
  app.save(messages);
  app.save(presence);

  console.log("[gw-mailbox] schema migration applied:", [
    users.name, teams.name, inboxes.name, threads.name, messages.name, presence.name
  ].join(", "));
}, (app) => {
  // Downgrade: drop mailbox tables. users is preserved (auth data, may be the
  // PB 0.39 auto-created collection — never delete it here).
  const names = ["thread_presence", "messages", "threads", "inboxes", "teams"];
  for (const name of names) {
    try {
      const c = app.findCollectionByNameOrId(name);
      app.delete(c);
      console.log("[gw-mailbox] schema rollback dropped:", name);
    } catch (_) { /* already gone */ }
  }
});
