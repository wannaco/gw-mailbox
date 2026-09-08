/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — mailbox "import history?" choice at setup
// Adds inboxes.import_history (bool). When an admin adds a mailbox they choose
// whether to pull in the mail ALREADY in the Gmail inbox (backfill on first
// sync — the original default) or start fresh and only receive NEW mail that
// arrives after setup. Existing mailboxes keep the legacy behavior (true).
// The engine honors it: a mailbox with import_history=false never auto-backfills
// on its first poll/watch; it jumps its history cursor to "now" instead. The
// per-mailbox "Backfill history" button can still import later if wanted.
// =============================================================================
migrate((app) => {
  const coll = app.findCollectionByNameOrId("inboxes");
  if (!coll.fields.getByName("import_history")) {
    coll.fields.addMarshaledJSON(JSON.stringify([{ name: "import_history", type: "bool" }]));
    app.save(coll);
    console.log("[gw-mailbox] inboxes.import_history added");
  } else {
    console.log("[gw-mailbox] inboxes.import_history already exists");
  }
  // Backfill existing rows to true — current mailboxes behave exactly as
  // before (their first sync may pull history), only NEW adds get the choice.
  try {
    const rows = app.findRecordsByFilter("inboxes", "", "", 0, 0) || [];
    let set = 0;
    for (const r of rows) {
      if (!r.getBool("import_history")) {
        r.set("import_history", true);
        app.save(r);
        set++;
      }
    }
    if (set > 0) console.log("[gw-mailbox] inboxes.import_history backfilled true on " + set + " existing mailbox(es)");
  } catch (err) {
    console.log("[gw-mailbox] inboxes.import_history backfill note:", (err && err.message) || err);
  }
}, (app) => {
  // Downgrade: leave field (non-destructive).
});
