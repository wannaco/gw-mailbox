/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — reporting timestamps (going-forward tracking)
// Adds to `threads`:
//   first_response_at  date — when an AGENT first replied to this ticket
//   closed_at          date — last time the ticket was moved to `closed`
// These let Reports compute per-agent first-response time / resolution time /
// reopen rate going forward (this PB fork has no created/updated on rows, so
// they can't be derived from history — we start stamping now).
// =============================================================================
migrate((app) => {
  const threads = app.findCollectionByNameOrId("threads");
  const ensureField = (coll, f) => { if (!coll.fields.getByName(f.name)) coll.fields.addMarshaledJSON(JSON.stringify([f])); };
  ensureField(threads, { name: "first_response_at", type: "date" });
  ensureField(threads, { name: "closed_at", type: "date" });
  app.save(threads);
  console.log("[gw-mailbox] threads.first_response_at / closed_at fields added");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
