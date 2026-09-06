/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — app-wide presence roster (the realtime layer)
//
// `thread_presence` only tracks people while a THREAD is open (draft locks).
// This collection tracks presence while the APP is open in ANY view — list,
// board or thread — so teammates can see who is online and what they're doing
// (viewing a thread / composing a reply). Superusers (admins) participate too
// (they are not in `users`, so the roster stores a denormalized actor key +
// display name instead of a relation).
//
//   actor          text  — stable key ("superuser" or the users-record id)
//   kind           select agent|admin
//   name / email   text  — denormalized display info
//   status         select online|viewing|composing_reply
//   thread         text  — current thread id (when in a thread)
//   thread_subject text  — denormalized subject for the roster tooltip
//   inbox          text  — current inbox id
//   updated_at     date  — heartbeat timestamp (roster = fresh within ~20s)
//
// One row per actor (unique index); upserted by POST /api/mailbox/presence/beat
// every ~8s while the app is visible, deleted on tab hide/close.
// =============================================================================
migrate((app) => {
  let ap;
  try {
    ap = app.findCollectionByNameOrId("agent_presence");
  } catch (_) {
    ap = new Collection({
      name: "agent_presence",
      type: "base",
      fields: [
        { name: "actor", type: "text", required: true, max: 64 },
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["agent", "admin"]
        },
        { name: "name", type: "text", max: 200 },
        { name: "email", type: "email" },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["online", "viewing", "composing_reply"]
        },
        { name: "thread", type: "text", max: 64 },
        { name: "thread_subject", type: "text", max: 500 },
        { name: "inbox", type: "text", max: 64 },
        { name: "updated_at", type: "date" }
      ]
    });
    app.save(ap);
    console.log("[gw-mailbox] agent_presence collection created");
  }

  // Any signed-in team member may read the roster (internal tool, whole-team
  // scope). Writes happen only server-side through the route handlers.
  ap.listRule = '@request.auth.id != ""';
  ap.viewRule = '@request.auth.id != ""';
  ap.createRule = null;
  ap.updateRule = null;
  ap.deleteRule = null;
  app.save(ap);

  // One heartbeat row per actor.
  if (!ap.getIndex("idx_agent_presence_actor")) {
    ap.addIndex("idx_agent_presence_actor", true, "actor");
    app.save(ap);
  }
  console.log("[gw-mailbox] agent_presence collection configured");
}, (app) => {
  // Downgrade: drop the roster collection (ephemeral by nature).
  try {
    const c = app.findCollectionByNameOrId("agent_presence");
    app.deleteCollection(c);
  } catch (_) { /* already gone */ }
});
