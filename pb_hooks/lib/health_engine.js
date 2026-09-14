// =============================================================================
// gw-mailbox — public health endpoint for an external uptime monitor
//
// Route (registered in main.pb.js): GET /api/mailbox/health
//
// WHY THIS EXISTS
// A monitor that only checks "is the container up?" misses the failure that
// actually hurts: the container is up, the API answers, and NO MAIL IS BEING
// INGESTED. That is how a stalled mailbox stays unnoticed for days. This
// endpoint reports sync freshness, so one monitor per client catches both.
//
// PUBLIC BY DESIGN — an uptime monitor cannot log in. It therefore exposes only
// aggregate facts: counts and staleness. No mailbox names, addresses, subjects
// or error text. Identify a failing mailbox by id if you need to dig.
//
// Optional shared secret: set MAILBOX_HEALTH_TOKEN and callers must pass
// ?token=<value> (or an X-Health-Token header). Unset = open.
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

// Poll sync runs every minute, so 15 minutes of silence means several ticks were
// missed — long enough to rule out a single slow pass, short enough to act on.
var STALE_AFTER_MINUTES = 15;

function tokenOk(e) {
  var required = $os.getenv("MAILBOX_HEALTH_TOKEN") || "";
  if (!required) return true;
  var got = "";
  try { got = String(e.request.url.query().get("token") || ""); } catch (_) { /* no query */ }
  if (!got) {
    try { got = String(e.request.header.get("X-Health-Token") || ""); } catch (_) { /* header absent */ }
  }
  return got === required;
}

function handleHealth(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  if (!tokenOk(e)) return h.fail(e, 403, "forbidden", "Health token required");

  var now = new DateTime();

  var inboxes = [];
  try {
    inboxes = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || [];
  } catch (_) { inboxes = []; }

  // Staleness only means something while polling. Under Pub/Sub push there is no
  // clock to fall behind — mail is ingested when Google says so — so a quiet
  // stretch is normal and must not raise an alarm.
  var pollEnabled = false;
  try { pollEnabled = require(__hooks + "/lib/settings_engine.js").effectivePollSync() === true; } catch (_) { /* default false */ }

  var lastOk = null;
  var failingIds = [];
  var unsynced = 0;
  for (var i = 0; i < inboxes.length; i++) {
    var ib = inboxes[i];
    var err = "";
    try { err = ib.getString("sync_error") || ""; } catch (_) { /* field may be absent */ }
    if (err) failingIds.push(ib.id);
    var d = null;
    try { d = ib.getDateTime("last_sync_at"); } catch (_) { /* field may be absent */ }
    if (d && !d.isZero()) {
      if (!lastOk || d.after(lastOk)) lastOk = d;
    } else {
      unsynced++;
    }
  }

  var minutesSince = null;
  if (lastOk) {
    minutesSince = Math.round(((now.unix() - lastOk.unix()) / 60) * 10) / 10;
  }

  var stale = false;
  if (pollEnabled && inboxes.length > 0) {
    stale = (minutesSince === null) || (minutesSince > STALE_AFTER_MINUTES);
  }

  // `ok` is the aggregate a keyword monitor should watch: it is true only when
  // nothing is stale AND nothing is failing. The HTTP status stays 200 either
  // way — the service IS up; it is the sync that is not.
  e.json(200, {
    ok: !stale && failingIds.length === 0,
    time: now.string(),
    sync: {
      mode: pollEnabled ? "poll" : "push",
      poll_enabled: pollEnabled,
      last_success_at: lastOk ? lastOk.string() : "",
      minutes_since_success: minutesSince,
      stale: stale,
      stale_after_minutes: STALE_AFTER_MINUTES,
      mailboxes: inboxes.length,
      never_synced: unsynced,
      failing: failingIds.length
    },
    failing_ids: failingIds
  });
}

module.exports = { handleHealth, STALE_AFTER_MINUTES };
