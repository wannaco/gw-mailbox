/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — add the "reply" notification kind
//
// Notifications were only ever created for mentions and notes, so NOTHING told
// an agent that a customer had replied on their ticket. This adds the kind the
// ingest path now writes.
//
//   reply  — a customer replied on a thread assigned to you
//
// "assigned" was already in the select but the server never produced one, so
// assigning a ticket was equally silent; that is fixed in code, not here.
// =============================================================================
migrate((app) => {
  let c;
  try {
    c = app.findCollectionByNameOrId("notifications");
  } catch (_) {
    return; // collection not created yet — 1786000011 adds it
  }
  const f = c.fields.getByName("kind");
  if (!f) return;
  const values = f.values || [];
  if (values.indexOf("reply") === -1) {
    f.values = values.concat(["reply"]);
    app.save(c);
    console.log("[gw-mailbox] notifications: added 'reply' kind");
  }
}, (app) => {
  // Downgrade: drop the kind. Rows already using it would then fail validation,
  // so they are removed first — a notification is disposable by nature.
  try {
    const c = app.findCollectionByNameOrId("notifications");
    const f = c.fields.getByName("kind");
    if (f) {
      const rows = app.findRecordsByFilter("notifications", "kind = 'reply'", "", 0, 0) || [];
      for (const r of rows) app.delete(r);
      f.values = (f.values || []).filter((v) => v !== "reply");
      app.save(c);
    }
  } catch (_) { /* nothing to undo */ }
});
