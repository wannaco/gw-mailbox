/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — notifications (mentions / internal notes / assignments)
// When an internal note @-mentions an agent (or a note lands on a thread they
// are assigned), a row is created here. The UI shows an unread badge + a
// dropdown; clicking opens the thread and jumps to the note.
//   user           text  — the recipient users-record id (or "superuser")
//   kind           select mention|note|assigned
//   thread         text  — thread id
//   thread_subject text  — denormalized for the list
//   message_id     text  — the internal-note message id (for jump-to)
//   actor_name     text  — who created it
//   body_snippet   text  — short preview
//   read           bool
//   created_at     date
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("notifications");
  } catch (_) {
    coll = new Collection({
      name: "notifications",
      type: "base",
      fields: [
        { name: "user", type: "text", required: true, max: 64 },
        {
          name: "kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["mention", "note", "assigned"]
        },
        { name: "thread", type: "text", max: 64 },
        { name: "thread_subject", type: "text", max: 500 },
        { name: "message_id", type: "text", max: 64 },
        { name: "actor_name", type: "text", max: 200 },
        { name: "body_snippet", type: "text", max: 300 },
        { name: "read", type: "bool" },
        { name: "created_at", type: "date" }
      ]
    });
    coll.listRule = 'user = @request.auth.id';
    coll.viewRule = 'user = @request.auth.id';
    coll.createRule = null; // server-created
    coll.updateRule = 'user = @request.auth.id'; // mark read
    coll.deleteRule = 'user = @request.auth.id';
    app.save(coll);
    console.log("[gw-mailbox] notifications collection created");
  }
  // index for unread-by-user
  if (!coll.getIndex("idx_notif_user")) {
    coll.addIndex("idx_notif_user", false, "user");
    app.save(coll);
  }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("notifications");
    app.deleteCollection(c);
  } catch (_) { /* gone */ }
});
