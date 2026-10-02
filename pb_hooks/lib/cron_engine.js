// =============================================================================
// gw-mailbox — cron engine jobs (module)
// See note in presence_api.js on why jobs live in a module (cron callbacks
// lose top-level .pb.js bindings).
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

var SLA_SCAN_STATUSES = ["new", "in_progress"];  // clock runs on New + In progress
var PRESENCE_MAX_AGE_MIN = 2;       // spec: older than 2 minutes

// ---- sync serialization ----------------------------------------------------
// Poll sync and the backfill stepper both hammer the Gmail API, and PB runs each
// cron job in its own goroutine — so a tick that overruns its minute can overlap
// with the next one. Two guards keep the Gmail/AI budget predictable:
//   * syncBusy     — only one Gmail-touching job runs at a time. Without this,
//                    a slow poll sync and a backfill could interleave and double
//                    the per-minute call volume.
//   * one mailbox  — the stepper advances ONE queued mailbox per tick (rotating),
//     per tick       so importing 5 mailboxes can't become 5x400 calls in a
//                    single minute and starve the poll sync.
var syncBusy = false;
var backfillBusy = false;
var backfillCursor = 0; // rotates so one huge import can't starve the others

// ---------------------------------------------------------------------------
// SLA breach monitor — hourly; escalate new/in-progress tickets past sla_due_at
// ---------------------------------------------------------------------------
function runSlaMonitor() {
  h.log("SLA monitor run started");
  const cfg = h.readSlaConfig();
  if (!cfg.sla_enabled) {
    h.log("SLA monitor skipped — disabled in Settings (sla_enabled=false)");
    return;
  }
  // IMPORTANT: do NOT sort by +created — this PocketBase fork has no created
  // field and PB throws on the sort, which silently killed every run before
  // (zero escalations ever despite days of overdue tickets). Fetch all rows of
  // each status with no sort; saves flip rows out of the filter so nothing is
  // re-scanned, and status subsets are small even on big mailboxes.
  const breached = [];
  const statusOf = {};
  let checked = 0;
  for (const status of SLA_SCAN_STATUSES) {
    let rows = [];
    try {
      rows = $app.findRecordsByFilter("threads", "status = {:s}", "", 0, 0, { s: status }) || [];
    } catch (err) {
      h.warn("SLA monitor scan failed for status", status, (err && err.message) || err);
      continue;
    }
    for (const rec of rows) {
      checked++;
      if (h.isSlaBreached(rec)) { breached.push(rec); statusOf[rec.id] = status; }
    }
  }

  for (const thread of breached) {
    try {
      thread.set("status", "escalated");
      $app.save(thread);

      const wasStatus = statusOf[thread.id] || "new";
      const note = h.addInternalNote(
        thread.id,
        { name: "SLA Monitor", email: "system@mailbox.local" },
        "⏰ SLA breach: ticket was still '" + wasStatus + "' past sla_due_at (" +
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

  h.log("SLA monitor run finished — checked:", checked, "breached:", breached.length);
  return { checked: checked, escalated: breached.length };
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
  // Overlap guard: skip this tick rather than run two Gmail passes at once.
  // The next tick is only 60s away, so a skip costs nothing.
  if (syncBusy) {
    h.warn("poll sync skipped — previous sync still running");
    return;
  }
  syncBusy = true;
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
  } finally {
    syncBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Backfill stepper — advance any mailbox whose history import is queued/running
// a few Gmail pages per tick. Started from Settings (per-mailbox "Backfill
// history") so mailboxes added on setup can pull in their EXISTING inbox mail
// without ever blocking a request. ~4 pages (<=400 conversations) per minute.
// ---------------------------------------------------------------------------
function runBackfillStepper() {
  // Yield the Gmail budget to a poll sync running in this tick.
  if (syncBusy) return;
  if (backfillBusy) return; // previous stepper still going (overrun, not overlap)

  let inboxes = [];
  try {
    inboxes = $app.findRecordsByFilter("inboxes", "is_active = true", "", 0, 0) || [];
  } catch (err) {
    h.warn("backfill stepper list failed:", err.message || err);
    return;
  }

  const queued = [];
  for (const inbox of inboxes) {
    try {
      let st = {};
      try { st = JSON.parse(inbox.getString("backfill_state") || "{}") || {}; } catch (_) {}
      if (st.status === "queued" || st.status === "running") queued.push(inbox);
    } catch (_) { /* unreadable state — leave it for the next tick */ }
  }
  if (!queued.length) return;

  // ONE mailbox per tick, rotating across the queue. A page is up to 100
  // conversations and stepBackfill does 4 pages, so this caps a backfill at
  // ~400 Gmail calls/minute no matter how many mailboxes are importing.
  if (backfillCursor >= queued.length) backfillCursor = 0;
  const target = queued[backfillCursor];
  backfillCursor = (backfillCursor + 1) % queued.length;

  backfillBusy = true;
  try {
    const gm = require(__hooks + "/lib/gmail_engine.js");
    const r = gm.stepBackfill(target, 4, 100);
    if (r && r.done) {
      h.log("backfill finished", target.getString("email_address"), "via stepper");
    }
    if (queued.length > 1 && backfillCursor === 0) {
      h.log("backfill: rotating across", queued.length, "queued mailbox(es)");
    }
  } catch (err) {
    h.warn("backfill stepper error for", target.getString("email_address"), (err && err.message) || err);
  } finally {
    backfillBusy = false;
  }
}

// Admin-only manual trigger (POST /api/mailbox/admin/run-sla-monitor) so a
// breach can be enforced immediately instead of waiting for the next hourly
// tick — and so this can be verified on demand.
function handleRunSlaMonitor(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isAdmin) return h.fail(e, 403, "forbidden", "Admins only");
  try {
    const r = runSlaMonitor();
    e.json(200, { ok: true, escalated: (r && r.escalated) || 0, checked: (r && r.checked) || 0 });
  } catch (err) {
    h.fail(e, 500, "sla_monitor_failed", (err && err.message) || String(err));
  }
}

// ---------------------------------------------------------------------------
// One-time cleanup: archive imported history that was swept into the queue.
//
// Before history imports were marked as archive, importing a mailbox created
// every old conversation as "new" with an SLA clock anchored to the ORIGINAL
// message date — so months-old mail read as overdue and the hourly monitor
// escalated the lot. On this instance that put 733 nine-month-old threads into
// the Escalated column.
//
// This archives threads that were never worked and have no owner:
//   status in (new, in_progress, escalated)
//   AND no first_response_at AND no closed_at   (nobody ever replied)
//   AND no assigned_agent                       (nobody owns it)
// Those three together mean "nobody has acted on this", which is the signature
// of imported history rather than a real backlog. Deliberately NOT a migration:
// it is a judgement call about existing data, so it stays an explicit admin
// action instead of running automatically on every future install.
function runArchiveImportedHistory(dryRun) {
  const STATUSES = ["new", "in_progress", "escalated"];
  let scanned = 0;
  let archived = 0;
  const perInbox = {};
  for (const status of STATUSES) {
    let rows = [];
    try {
      rows = $app.findRecordsByFilter("threads", "status = {:s}", "", 0, 0, { s: status }) || [];
    } catch (err) {
      h.warn("archive-history scan failed for", status, (err && err.message) || err);
      continue;
    }
    for (const t of rows) {
      scanned++;
      try {
        const fr = t.getDateTime("first_response_at");
        const cl = t.getDateTime("closed_at");
        const hasAgent = !!(t.getString("assigned_agent") || "").trim();
        if ((fr && !fr.isZero()) || (cl && !cl.isZero()) || hasAgent) continue;
        const ib = t.getString("inbox") || "?";
        perInbox[ib] = (perInbox[ib] || 0) + 1;
        if (dryRun) { archived++; continue; }
        t.set("status", "archived");
        t.set("sla_due_at", ""); // archive has no clock — the monitor skips it
        $app.save(t);
        archived++;
      } catch (err) {
        h.warn("archive-history skip", t.id, (err && err.message) || err);
      }
    }
  }
  return { scanned: scanned, archived: archived, perInbox: perInbox, dryRun: !!dryRun };
}

// POST /api/mailbox/admin/archive-imported-history[?dryRun=1]
function handleArchiveImportedHistory(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isAdmin) return h.fail(e, 403, "forbidden", "Admins only");
  let dryRun = false;
  try {
    const q = e.request.url.query();
    dryRun = (q.get("dryRun") || "") === "1";
  } catch (_) { /* default: perform */ }
  try {
    const r = runArchiveImportedHistory(dryRun);
    e.json(200, { ok: true, dryRun: r.dryRun, scanned: r.scanned, archived: r.archived, byInbox: r.perInbox });
  } catch (err) {
    h.fail(e, 500, "archive_history_failed", (err && err.message) || String(err));
  }
}


// ---------------------------------------------------------------------------
// One-off repair: remove Gmail DRAFTS that were ingested before drafts were
// filtered (see `is_draft` in gmail_engine.js). Until that guard existed, a
// half-written reply was stored as if it had been sent — and because Gmail
// issues a fresh message id each time a draft is saved, a long compose session
// left a run of bogus messages in the thread, plus bogus threads for drafts
// whose thread sat in the inbox.
//
// A draft is always authored by the mailbox itself, so only messages whose
// sender IS the inbox address are inspected — sent replies and drafts, not
// customer mail. That keeps the API calls proportional to the small set rather
// than to the whole mailbox.
//
// Gmail is the source of truth: a message is only deleted locally if Gmail says
// it currently carries the DRAFT label. A message that cannot be fetched (404 —
// draft discarded, or mail deleted) is left alone rather than guessed at.
//
//   POST /api/mailbox/admin/cleanup-drafts[?dryRun=1][&max=300]
function runCleanupDrafts(dryRun, max) {
  const cap = max || 300;
  const inboxes = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || [];
  const perInbox = [];
  let scanned = 0, drafts = 0, deleted = 0, threadsDeleted = 0, unchecked = 0;

  for (const inbox of inboxes) {
    const uid = inbox.getString("email_address");
    if (!uid) continue;
    const authored = $app.findRecordsByFilter("messages", "sender_email = {:e}", "", 0, 0, { e: uid }) || [];

    // thread id -> draft message records found in it
    const hits = {};
    for (const m of authored) {
      if (scanned >= cap) { unchecked++; continue; }
      const gid = m.getString("gmail_message_id");
      if (!gid) continue;
      scanned++;
      let labels = [];
      try {
        const res = h.googleRequest({
          url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/messages/" + encodeURIComponent(gid) + "?format=minimal",
          scopes: [h.GMAIL_SCOPE],
          subject: uid
        });
        labels = (res && res.labelIds) || [];
      } catch (_) {
        continue; // gone from Gmail, or unreadable — never delete on a guess
      }
      if (labels.indexOf("DRAFT") === -1) continue;
      drafts++;
      const tid = m.getString("thread");
      if (!hits[tid]) hits[tid] = [];
      hits[tid].push(m);
    }

    let inboxDeleted = 0, inboxThreadsGone = 0;
    for (const tid of Object.keys(hits)) {
      const inThread = $app.findRecordsByFilter("messages", "thread = {:t}", "", 0, 0, { t: tid }) || [];
      const doomed = hits[tid].length;
      const emptyAfter = inThread.length - doomed;
      if (!dryRun) {
        for (const m of hits[tid]) {
          try { $app.delete(m); inboxDeleted++; } catch (_) { /* leave it */ }
        }
        // A thread that existed only because of the draft has nothing left.
        if (emptyAfter <= 0) {
          try {
            const t = h.safeFindById("threads", tid);
            if (t) { $app.delete(t); inboxThreadsGone++; }
          } catch (_) { /* leave it */ }
        }
      } else {
        inboxDeleted += doomed;
        if (emptyAfter <= 0) inboxThreadsGone++;
      }
    }
    deleted += inboxDeleted;
    threadsDeleted += inboxThreadsGone;
    perInbox.push({ inbox: inbox.getString("name") || uid, authored: authored.length, drafts: Object.keys(hits).reduce((n, k) => n + hits[k].length, 0), deleted: inboxDeleted, threadsDeleted: inboxThreadsGone });
  }
  return { dryRun: !!dryRun, scanned: scanned, drafts: drafts, deleted: deleted, threadsDeleted: threadsDeleted, unchecked: unchecked, perInbox: perInbox };
}

// POST /api/mailbox/admin/cleanup-drafts[?dryRun=1][&max=N]
function handleCleanupDrafts(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isAdmin) return h.fail(e, 403, "forbidden", "Admins only");
  let dryRun = false, max = 300;
  try {
    const q = e.request.url.query();
    dryRun = (q.get("dryRun") || "") === "1";
    const m = parseInt(q.get("max") || "", 10);
    if (m > 0) max = m;
  } catch (_) { /* defaults */ }
  try {
    const r = runCleanupDrafts(dryRun, max);
    e.json(200, { ok: true, ...r });
  } catch (err) {
    h.fail(e, 500, "cleanup_drafts_failed", (err && err.message) || String(err));
  }
}

module.exports = {
  runSlaMonitor,
  handleRunSlaMonitor,
  runArchiveImportedHistory,
  handleArchiveImportedHistory,
  runCleanupDrafts,
  handleCleanupDrafts,
  runPresenceSweeper,
  runMailPollSync,
  runBackfillStepper
};
