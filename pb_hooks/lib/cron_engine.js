// =============================================================================
// gw-mailbox — cron engine jobs (module)
// See note in presence_api.js on why jobs live in a module (cron callbacks
// lose top-level .pb.js bindings).
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

var SLA_SCAN_STATUS = "new";        // spec: tickets in `new`
var PRESENCE_MAX_AGE_MIN = 2;       // spec: older than 2 minutes
var BATCH = 200;

// ---------------------------------------------------------------------------
// SLA breach monitor — hourly; escalate new tickets past sla_due_at
// ---------------------------------------------------------------------------
function runSlaMonitor() {
  h.log("SLA monitor run started");
  const breached = [];
  let offset = 0;

  // Drain in batches; a fresh save flips the row out of the status filter so
  // the next page offset stays consistent.
  while (true) {
    const rows = $app.findRecordsByFilter("threads", "status = {:s}", "+created", BATCH, offset, { s: SLA_SCAN_STATUS });
    if (!rows || rows.length === 0) break;
    for (const rec of rows) {
      if (h.isSlaBreached(rec)) breached.push(rec);
    }
    if (rows.length < BATCH) break;
    offset += BATCH;
  }

  for (const thread of breached) {
    try {
      thread.set("status", "escalated");
      $app.save(thread);

      const note = h.addInternalNote(
        thread.id,
        { name: "SLA Monitor", email: "system@mailbox.local" },
        "⏰ SLA breach: ticket was still '" + SLA_SCAN_STATUS + "' past sla_due_at (" +
          h.dateToPbString(thread.getDateTime("sla_due_at")) + ") — escalated for review."
      );

      h.sendAlertWebhook("sla_breach", {
        threadId: thread.id,
        subject: thread.getString("subject") || "(no subject)",
        customer_email: thread.getString("customer_email"),
        inbox: thread.getString("inbox"),
        sla_due_at: h.dateToPbString(thread.getDateTime("sla_due_at")),
        noteId: note ? note.id : null
      });
      h.log("SLA breached -> escalated", thread.id, thread.getString("subject"));
    } catch (err) {
      h.warn("SLA escalation failed for", thread.id, err.message || err);
    }
  }

  h.log("SLA monitor run finished — breached:", breached.length);
}

// ---------------------------------------------------------------------------
// Stale presence sweeper — every minute; drop heartbeats older than 2 min
// ---------------------------------------------------------------------------
function runPresenceSweeper() {
  const cutoff = new DateTime().add(-PRESENCE_MAX_AGE_MIN * 60 * 1e9);
  const stale = $app.findRecordsByFilter(
    "thread_presence",
    "updated_at <= {:cutoff}",
    "",
    0,
    0,
    { cutoff: cutoff.string() }
  );

  let removed = 0;
  for (const row of stale || []) {
    try {
      $app.delete(row);
      removed++;
    } catch (err) {
      h.warn("presence sweep delete failed", row.id, err.message || err);
    }
  }

  // App-wide roster rows refresh every ~8s; anything older than 45s is a dead
  // tab/agent (offline is handled by the beat/offline routes; this is the
  // safety net for crashes / lost connections).
  const apCutoff = new DateTime().add(-180 * 1e9); // 3 min
  const staleAp = $app.findRecordsByFilter(
    "agent_presence",
    "updated_at <= {:cutoff}",
    "",
    0,
    0,
    { cutoff: apCutoff.string() }
  );
  for (const row of staleAp || []) {
    try {
      $app.delete(row);
      removed++;
    } catch (err) {
      h.warn("roster sweep delete failed", row.id, err.message || err);
    }
  }

  if (removed > 0) h.log("presence sweeper removed", removed, "stale row(s)");
}

// ---------------------------------------------------------------------------
// Gmail poll sync — when MAILBOX_POLL_SYNC=1 every active inbox is synced on
// an interval (no Pub/Sub required). Incremental from inbox.history_id;
// backfills on first run. Needs a service account (GOOGLE_SA_JSON/FILE).
// ---------------------------------------------------------------------------
function runMailPollSync() {
  try {
    if (require(__hooks + "/lib/settings_engine.js").effectivePollSync() !== true) return;
  } catch (_) { return; }
  try {
    const gm = require(__hooks + "/lib/gmail_engine.js");
    const inboxes = $app.findRecordsByFilter("inboxes", "is_active = true", "", 0, 0) || [];
    for (const inbox of inboxes) {
      if (!inbox.getString("email_address")) continue;
      try {
        const counters = gm.syncInbox(inbox, { maxPages: 3, maxResults: 25 });
        const total = (counters.threadsCreated || 0) + (counters.messagesAdded || 0);
        if (total > 0) {
          h.log("poll sync:", inbox.getString("email_address"), JSON.stringify(counters));
        }
      } catch (err) {
        h.warn("poll sync failed for", inbox.getString("email_address"), err.message || err);
      }
    }
  } catch (err) {
    h.warn("poll sync error:", err.message || err);
  }
}

module.exports = {
  runSlaMonitor,
  runPresenceSweeper,
  runMailPollSync
};
