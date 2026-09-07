/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — CSAT feedback
// A per-ticket satisfaction survey. When a thread is CLOSED, the engine emails
// the customer a unique link to a public page (no login) where they pick a
// 1–5 star rating + optional comment. Feedback is stored against the ticket +
// customer email and shown to agents in the thread drawer.
//
//   token         text  req, unique — unguessable survey key (public link)
//   thread        relation → threads (cascade delete)
//   inbox         text  — denormalized inbox id (for scoping/listing)
//   email         email — customer address the survey was sent to
//   rating        number (1..5) — null until responded
//   comment       text (optional)
//   sent_at       date  — when the survey email was dispatched
//   responded_at  date  — when the customer submitted
//
// Rules: read/view restricted to agents (any authed); create only via engine
// (public page writes through a custom handler, not the collection API).
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("csat_feedback");
  } catch (_) {
    coll = null;
  }
  if (!coll) {
    let threads;
    try { threads = app.findCollectionByNameOrId("threads"); } catch (_) { threads = null; }

    coll = new Collection({
      name: "csat_feedback",
      type: "base",
      fields: [
        { name: "token", type: "text", required: true, max: 100 },
        { name: "thread", type: "relation", maxSelect: 1, collectionId: threads ? threads.id : "", cascadeDelete: true },
        { name: "inbox", type: "text", max: 100 },
        { name: "email", type: "email" },
        { name: "rating", type: "number", min: 1, max: 5, onlyInt: true },
        { name: "comment", type: "text", max: 5000 },
        { name: "sent_at", type: "date" },
        { name: "responded_at", type: "date" }
      ]
    });
    coll.listRule = '@request.auth.id != ""';
    coll.viewRule = '@request.auth.id != ""';
    coll.createRule = null;   // engine-only
    coll.updateRule = null;   // engine-only
    coll.deleteRule = null;
    app.save(coll);

    // Unique index on the public token (link is the auth).
    if (!coll.getIndex("idx_csat_token")) {
      coll.addIndex("idx_csat_token", true, "token");
      app.save(coll);
    }
    console.log("[gw-mailbox] csat_feedback collection created");
  } else {
    console.log("[gw-mailbox] csat_feedback already exists");
  }

  // app_settings.public_url — absolute base the CSAT survey link uses in the
  // auto-sent email. Backfill once so existing installs don't send dead links.
  try {
    const as = app.findCollectionByNameOrId("app_settings");
    if (!as.fields.getByName("public_url")) {
      as.fields.addMarshaledJSON(JSON.stringify([{ name: "public_url", type: "text", max: 200 }]));
      app.save(as);
    }
    const rec = app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    if (rec && !rec.getString("public_url")) {
      rec.set("public_url", "https://mailbox.thinkcloud.dev");
      app.save(rec);
    }
    console.log("[gw-mailbox] app_settings.public_url ensured");
  } catch (_) { /* settings row may not exist yet */ }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("csat_feedback");
    app.deleteCollection(c);
  } catch (_) { /* gone */ }
});
