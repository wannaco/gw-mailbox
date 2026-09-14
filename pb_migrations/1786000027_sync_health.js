/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — sync health fields
//
// Adds two fields to `inboxes` so a stalled sync becomes VISIBLE instead of
// silent:
//   last_sync_at  date  — stamped on every SUCCESSFUL sync/backfill step
//   sync_error    text  — last failure message; cleared on success
//
// Why: the worst failure for this product is not an error, it is silence. A
// mailbox can stop ingesting (expired Gmail history cursor, revoked delegation,
// network) and the app still looks perfectly healthy — the customer only finds
// out when someone asks "did you get my email?". These fields let
// GET /api/mailbox/health report staleness so an external monitor can alert.
// =============================================================================
migrate((app) => {
  const coll = app.findCollectionByNameOrId("inboxes");
  const add = [];
  if (!coll.fields.getByName("last_sync_at")) add.push({ name: "last_sync_at", type: "date" });
  if (!coll.fields.getByName("sync_error")) add.push({ name: "sync_error", type: "text", max: 500 });
  if (add.length) {
    coll.fields.addMarshaledJSON(JSON.stringify(add));
    app.save(coll);
    console.log("[gw-mailbox] inboxes.last_sync_at / sync_error added");
  } else {
    console.log("[gw-mailbox] inboxes sync-health fields already exist");
  }
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
