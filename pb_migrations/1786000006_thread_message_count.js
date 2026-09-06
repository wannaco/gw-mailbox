/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — per-thread message count
// Adds to `threads`:
//   message_count  number (int) — number of conversation messages (excludes
//                    internal notes) so the UI can show a per-thread count and
//                    derive unread/new-message state in realtime.
// Backfills absolute counts from existing `messages` rows (idempotent — recomputed
// from the collection, safe to re-run).
// =============================================================================
migrate((app) => {
  const threads = app.findCollectionByNameOrId("threads");
  if (!threads.fields.getByName("message_count")) {
    threads.fields.addMarshaledJSON(JSON.stringify([
      { name: "message_count", type: "number", min: 0, onlyInt: true }
    ]));
    app.save(threads);
    console.log("[gw-mailbox] threads.message_count field added");
  }

  let updated = 0;
  const all = app.findRecordsByFilter("threads", "", "", 0, 0);
  for (const t of all || []) {
    // NOTE: this PB fork's signature is findRecordsByFilter(collection, filter,
    // sort, limit, offset, params) — params is the 6th argument.
    const msgs = app.findRecordsByFilter(
      "messages",
      "thread = {:tid} && is_internal_note = false",
      "", 0, 0,
      { tid: t.id }
    );
    const n = (msgs || []).length;
    if (t.getInt("message_count") !== n) {
      try {
        t.set("message_count", n);
        app.save(t);
        updated++;
      } catch (err) {
        console.log("[gw-mailbox] message_count backfill skip", t.id, String((err && err.message) || err));
      }
    }
  }
  if (updated) console.log("[gw-mailbox] threads.message_count backfilled", updated, "thread(s)");
}, (app) => {
  // Downgrade: leave the field + data (no-op).
});
