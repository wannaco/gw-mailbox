/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — mailbox backfill state
// Adds inboxes.backfill_state (text, JSON) — holds the paged history-import
// progress so a mailbox added on setup can pull in its EXISTING received mail:
//   { status: "idle"|"queued"|"running"|"done"|"error",
//     threads, messages, batches, next_page, started_at, done_at, error }
// The engine writes this as it pages through Gmail (q=in:inbox); the UI reads
// it via inboxToView to show "Importing… / Done — N imported". Default "" =
// idle, so existing installs are unaffected.
// =============================================================================
migrate((app) => {
  const coll = app.findCollectionByNameOrId("inboxes");
  if (!coll.fields.getByName("backfill_state")) {
    coll.fields.addMarshaledJSON(JSON.stringify([{ name: "backfill_state", type: "text", max: 2000 }]));
    app.save(coll);
    console.log("[gw-mailbox] inboxes.backfill_state added");
  } else {
    console.log("[gw-mailbox] inboxes.backfill_state already exists");
  }
}, (app) => {
  // Downgrade: leave field (non-destructive).
});
