/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — SLA anchor backfill
// The thread-create hook stamped sla_due_at = "now + SLA hours" at IMPORT time,
// so old mail backfilled into the mailbox got a fresh ~24h deadline and shows
// a bogus "Due in Xh" countdown even though the emails are months old.
// Fix: anchor sla_due_at to the thread's REAL last activity (last_message_at
// + SLA hours). Old unanswered tickets correctly become OVERDUE; fresh tickets
// keep their normal ~now+window deadline. Engine create/update paths were also
// fixed to anchor going forward.
// =============================================================================
migrate((app) => {
  let hours = 24;
  try {
    const s = app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    if (s) {
      const v = s.get("sla_hours");
      const n = (v === undefined || v === null || v === "") ? 24 : Number(v);
      if (!isNaN(n) && n > 0) hours = n;
    }
  } catch (_) { /* settings row may not exist yet */ }

  const rows = app.findRecordsByFilter("threads", "status = {:s}", "", 0, 0, { s: "new" }) || [];
  let fixed = 0;
  let skipped = 0;
  for (const t of rows) {
    try {
      const last = t.getDateTime("last_message_at");
      if (!last || last.isZero()) { skipped++; continue; }
      const due = last.add(hours * 3600 * 1e9);
      t.set("sla_due_at", due.string());
      app.save(t);
      fixed++;
    } catch (err) {
      console.log("[gw-mailbox] SLA backfill skip", t.id, (err && err.message) || err);
      skipped++;
    }
  }
  console.log("[gw-mailbox] SLA anchor backfill: recomputed sla_due_at for " + fixed + " new threads (hours=" + hours + ", skipped " + skipped + ")");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
