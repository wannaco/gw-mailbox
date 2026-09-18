/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — one presence row per (thread, user)
//
// WHY: `thread_presence` had no uniqueness constraint, so two concurrent
// heartbeats (the join beat and the interval firing together, or two tabs)
// could both see "no row" and both INSERT. The result is two rows for the same
// person on the same thread — and nothing ever reconciled them:
//
//   - findPresence() uses findFirstRecordByFilter with no sort, so it kept
//     returning one of them (whichever the storage layer yielded first) and
//     updated only that one;
//   - releasePresence() deleted only that same one;
//   - the duplicate therefore survived every heartbeat AND every release.
//
// The visible effect: a stale row (e.g. "viewing") lived alongside the live
// one ("composing_reply"), and whichever the client applied last decided
// whether the composer locked. Agents saw no lock while someone was actively
// drafting, and "X is drafting" could appear while X was idle.
//
// The unique index makes the duplicate impossible at the storage layer. The
// dedupe pass handles databases that already have them, keeping the freshest
// row per (thread, user) — the newest heartbeat is the truth.
// =============================================================================
migrate((app) => {
  let c;
  try {
    c = app.findCollectionByNameOrId("thread_presence");
  } catch (_) {
    return; // collection not created yet — 1786000000 will add it
  }

  // 1. Collapse existing duplicates before adding the constraint, or the index
  //    creation fails on any database that already has them.
  let removed = 0;
  try {
    const rows = app.findRecordsByFilter("thread_presence", "", "-updated_at", 0, 0) || [];
    const keep = {};
    for (const r of rows) {
      const key = r.getString("thread") + "|" + r.getString("user");
      if (keep[key]) {
        app.delete(r); // an older row for the same pair
        removed++;
      } else {
        keep[key] = true; // rows are sorted newest-first, so the first wins
      }
    }
  } catch (err) {
    console.log("[gw-mailbox] thread_presence dedupe skipped: " + (err && err.message));
  }

  // 2. One row per (thread, user).
  if (!c.getIndex("idx_thread_presence_pair")) {
    c.addIndex("idx_thread_presence_pair", true, "thread, user");
    app.save(c);
  }
  console.log("[gw-mailbox] thread_presence unique (thread,user); removed " + removed + " duplicate row(s)");
}, (app) => {
  // Downgrade: drop the uniqueness constraint (rows themselves are ephemeral).
  try {
    const c = app.findCollectionByNameOrId("thread_presence");
    c.removeIndex("idx_thread_presence_pair");
    app.save(c);
  } catch (_) { /* nothing to undo */ }
});
