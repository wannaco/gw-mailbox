/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — per-thread internal-note count
// Adds to `threads`:
//   notes_count  number (int) — number of INTERNAL NOTES on the thread.
//
// Internal notes were deliberately excluded from `message_count` and from the
// unread/new-message tracking (both only count customer conversation messages).
// That left no way to tell an agent "there are 2 internal comments you haven't
// read" — mentions produce a bell notification, but a plain note (context from a
// colleague, an automations entry, a CSAT log) was invisible until you happened
// to open the thread and switch to the Internal notes tab.
//
// This counter is the source for that badge. It is maintained by
// addInternalNote(), which is the single choke point every note goes through
// (UI notes, @mention notes, automations, auto-close, CSAT, calendar).
//
// Backfill is a single pass over the notes rather than one query per thread, so
// it stays cheap on a large install.
// =============================================================================
migrate((app) => {
  const threads = app.findCollectionByNameOrId("threads");
  if (!threads.fields.getByName("notes_count")) {
    threads.fields.addMarshaledJSON(JSON.stringify([
      { name: "notes_count", type: "number", min: 0, onlyInt: true }
    ]));
    app.save(threads);
    console.log("[gw-mailbox] threads.notes_count field added");
  } else {
    console.log("[gw-mailbox] threads.notes_count already exists");
  }

  // Tally every internal note once, then write the counts back.
  const tally = {};
  let scanned = 0;
  let page = 1;
  for (;;) {
    let rows = [];
    try {
      // Paged so a mailbox with a large message table does not load it all at once.
      rows = app.findRecordsByFilter("messages", "is_internal_note = true", "", 500, (page - 1) * 500) || [];
    } catch (err) {
      console.log("[gw-mailbox] notes_count backfill scan failed:", (err && err.message) || err);
      break;
    }
    if (!rows.length) break;
    for (const m of rows) {
      const tid = m.getString("thread");
      if (!tid) continue;
      tally[tid] = (tally[tid] || 0) + 1;
      scanned++;
    }
    if (rows.length < 500) break;
    page++;
  }

  let written = 0;
  for (const tid in tally) {
    try {
      const t = app.findRecordById("threads", tid);
      if (t.getInt("notes_count") !== tally[tid]) {
        t.set("notes_count", tally[tid]);
        app.save(t);
        written++;
      }
    } catch (_) { /* thread deleted between scan and write — ignore */ }
  }
  console.log("[gw-mailbox] notes_count backfill: " + scanned + " note(s) across " + written + " thread(s)");
}, (app) => {
  // Downgrade: leave the field (non-destructive).
});
