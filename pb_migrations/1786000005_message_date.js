/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — per-message timestamp
// Adds to `messages`:
//   msg_date  date — when the message was sent/received (Gmail internalDate for
//                    synced mail, send time for replies, now for notes).
// This fork of PocketBase does NOT expose created/updated system fields (and
// `sort=created` on messages returns 400), so we carry our own sortable date.
// Backfills existing rows from their thread's last_message_at (approximate).
// =============================================================================
migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  if (!messages.fields.getByName("msg_date")) {
    messages.fields.addMarshaledJSON(JSON.stringify([
      { name: "msg_date", type: "date" }
    ]));
    app.save(messages);
    console.log("[gw-mailbox] messages.msg_date field added");
  }

  // Backfill: for rows without a date, approximate from the owning thread's
  // last_message_at (best available signal for already-synced mail).
  let filled = 0;
  const threads = app.findRecordsByFilter("threads", "", "", 0, 0);
  for (const t of threads || []) {
    const last = t.getString("last_message_at") || "";
    if (!last) continue;
    const msgs = app.findRecordsByFilter("messages", "thread = {:tid}", { tid: t.id }, 0, 0);
    for (const m of msgs || []) {
      if (m.getString("msg_date")) continue;
      try { m.set("msg_date", last); app.save(m); filled++; }
      catch (err) { console.log("[gw-mailbox] msg_date backfill skip", m.id, String(err && err.message || err)); }
    }
  }
  if (filled) console.log("[gw-mailbox] messages.msg_date backfilled", filled, "row(s)");
}, (app) => {
  // Downgrade: leave the field + data (dropping dates is harmless but noisy); no-op.
});
