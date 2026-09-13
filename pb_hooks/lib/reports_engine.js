// =============================================================================
// gw-mailbox — reporting engine
// Live aggregates over the inboxes the request actor can see (admins see all,
// agents see their inboxes). Returns status/assignee volume, open vs closed,
// SLA overdue count, CSAT average, and per-agent open/closed counts. Historical
// resolution time is limited (no created/closed stamps existed before this
// build) — but threads now carry first_response_at/closed_at going forward.
//
// Route (registered in main.pb.js): GET /api/mailbox/reports
//
// Query params:
//   inbox=<id>   scope to ONE mailbox (must be one the actor may see).
//                Omitted/empty = every permitted mailbox combined.
//   range=week|month|quarter|year|all   (default all)
//
// Range semantics: a thread counts if its last_message_at falls inside the
// window. That is "conversations active in this period", NOT "created in it" —
// this PB fork has no created field, and an activity window is the honest
// thing we can compute. Threads with no date at all are excluded once a range
// is chosen (they cannot be placed in time). CSAT is filtered by response date.
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

// Days per range keyword. 0 = no cutoff (all time).
var RANGE_DAYS = { week: 7, month: 30, quarter: 90, year: 365, all: 0 };

function rangeDays(key) {
  var k = String(key || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANGE_DAYS, k) ? RANGE_DAYS[k] : 0;
}

// Cutoff as a unix timestamp (seconds). 0 means "no cutoff".
function cutoffFor(days) {
  if (!days) return 0;
  try { return new DateTime().unix() - days * 86400; } catch (_) { return 0; }
}

// A record's date field as unix seconds; 0 when absent/invalid.
function tsUnix(rec, field) {
  try {
    var d = rec.getDateTime(field);
    if (d && !d.isZero()) return d.unix();
  } catch (_) { /* fall through */ }
  return 0;
}

function agentName(id) {
  try {
    const u = h.safeFindById("users", id);
    return u ? (u.getString("name") || u.getString("email")) : id;
  } catch (_) { return id; }
}

function handleReports(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  // ---- query params --------------------------------------------------------
  let wantedInbox = "";
  let rangeKey = "all";
  try {
    const q = e.request.url.query();
    wantedInbox = String(q.get("inbox") || "").trim();
    rangeKey = String(q.get("range") || "all").trim().toLowerCase();
  } catch (_) { /* defaults */ }
  if (Object.prototype.hasOwnProperty.call(RANGE_DAYS, rangeKey) === false) rangeKey = "all";
  const days = rangeDays(rangeKey);
  const cutoff = cutoffFor(days);

  // Scope: all active inboxes for admins; permitted inboxes for agents.
  let inboxIds = [];
  try {
    if (actor.isAdmin) {
      const all = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || [];
      inboxIds = (all || []).map((r) => r.id);
    } else {
      inboxIds = h.inboxIdsForUser(actor.recordId || actor.id).all;
    }
  } catch (_) { inboxIds = []; }
  const inboxSet = {};
  for (const id of inboxIds) inboxSet[id] = true;

  // Narrow to a single mailbox only if the actor is allowed to see it — a
  // bogus or forbidden id must not silently widen or leak another mailbox.
  if (wantedInbox) {
    if (inboxSet[wantedInbox]) inboxIds = [wantedInbox];
    else wantedInbox = "";
  }

  // Load every thread across those inboxes (each inbox's own records).
  const threads = [];
  for (const id of inboxIds) {
    try {
      const rows = $app.findRecordsByFilter("threads", "inbox = {:i}", "", 0, 0, { i: id }) || [];
      for (const r of rows) {
        if (cutoff > 0) {
          const ts = tsUnix(r, "last_message_at");
          if (!ts || ts < cutoff) continue; // undated or outside the window
        }
        threads.push(r);
      }
    } catch (_) { /* skip */ }
  }

  const OPEN = ["new", "in_progress", "waiting_customer", "escalated"];
  const byStatus = {};
  const byAssignee = {};   // agentId or "(unassigned)" -> {open, closed, total}
  const byInbox = {};
  let open = 0, closed = 0, spamArchived = 0, slaOverdue = 0, slaDueSoon = 0, totalSla = 0;
  let agentFirsts = {};    // agent -> count of tickets they first-responded (closed & stamped)

  for (const t of threads) {
    const st = t.getString("status") || "new";
    byStatus[st] = (byStatus[st] || 0) + 1;
    const ib = t.getString("inbox");
    byInbox[ib] = (byInbox[ib] || 0) + 1;

    if (OPEN.indexOf(st) !== -1) open++;
    else if (st === "closed") closed++;
    else spamArchived++;

    const due = t.getDateTime("sla_due_at");
    if (due && !due.isZero()) {
      totalSla++;
      if (due.before(new DateTime())) slaOverdue++;
      else {
        const remNs = due.sub(new DateTime());
        const hoursLeft = remNs / 1e9 / 3600;
        if (hoursLeft <= 24) slaDueSoon++;
      }
    }

    const assignee = t.getString("assigned_agent") || "(unassigned)";
    const bucket = byAssignee[assignee] || { open: 0, closed: 0, total: 0 };
    bucket.total++;
    if (OPEN.indexOf(st) !== -1) bucket.open++;
    else if (st === "closed") bucket.closed++;
    byAssignee[assignee] = bucket;

    // Per-agent handled count (closed tickets they had, or last assigned).
    const fr = t.getDateTime("first_response_at");
    if (fr && !fr.isZero() && assignee !== "(unassigned)") {
      agentFirsts[assignee] = (agentFirsts[assignee] || 0) + 1;
    }
  }

  // CSAT (scoped to the same inboxes via denormalized inbox field).
  let csatResponses = 0, csatSum = 0, csatPending = 0;
  for (const id of inboxIds) {
    try {
      const rows = $app.findRecordsByFilter("csat_feedback", "inbox = {:i}", "", 0, 0, { i: id }) || [];
      for (const r of rows) {
        const resp = r.getDateTime("responded_at");
        if (resp && !resp.isZero()) {
          // Ranged views filter on the response date; "all" counts everything.
          if (cutoff > 0) {
            const ts = tsUnix(r, "responded_at");
            if (!ts || ts < cutoff) continue;
          }
          const rt = r.getInt("rating") || 0;
          if (rt > 0) { csatResponses++; csatSum += rt; }
        } else if (cutoff === 0) {
          csatPending++; // a pending survey has no date to place in a window
        }
      }
    } catch (_) { /* skip */ }
  }

  // First-response / resolution times — computed only for threads actually
  // stamped (bounded to the 200 most recent so one reports call stays cheap on
  // big mailboxes). "Arrival" = the earliest real (non-internal) message date
  // on the thread; first_response_at / closed_at are stamped by the engine.
  function arrivalFor(threadId) {
    try {
      const msgs = $app.findRecordsByFilter("messages", "thread = {:t}", "", 0, 0, { t: threadId }) || [];
      let earliest = "";
      for (const m of msgs) {
        if (m.getBool("is_internal_note")) continue;
        const d = m.getString("msg_date") || "";
        if (d && (!earliest || d < earliest)) earliest = d;
      }
      return earliest ? new DateTime(earliest) : null;
    } catch (_) { return null; }
  }
  let frN = 0, frSumNs = 0, resN = 0, resSumNs = 0;
  const handled = threads.filter((t) => {
    const fr = t.getDateTime("first_response_at");
    const cl = t.getDateTime("closed_at");
    return (fr && !fr.isZero()) || (cl && !cl.isZero());
  }).slice(0, 200);
  for (const t of handled) {
    try {
      const arrival = arrivalFor(t.id);
      if (!arrival) continue;
      const fr = t.getDateTime("first_response_at");
      if (fr && !fr.isZero()) {
        const diff = fr.sub(arrival);
        if (diff > 0) { frN++; frSumNs += diff; }
      }
      const cl = t.getDateTime("closed_at");
      if (cl && !cl.isZero()) {
        const diff = cl.sub(arrival);
        if (diff > 0) { resN++; resSumNs += diff; }
      }
    } catch (_) { /* skip */ }
  }
  const toHours = (ns) => ns / 1e9 / 3600;

  // Agent rows (for the leaderboard) — resolve names, filter empties.
  const agentRows = Object.keys(byAssignee)
    .filter((k) => k !== "(unassigned)")
    .map((k) => ({
      id: k,
      name: agentName(k),
      open: byAssignee[k].open,
      closed: byAssignee[k].closed,
      total: byAssignee[k].total,
      first_responses: agentFirsts[k] || 0
    }))
    .sort((a, b) => (b.closed + b.total) - (a.closed + a.total));

  const inboxNames = {};
  for (const id of inboxIds) {
    try {
      const ib = h.safeFindById("inboxes", id);
      inboxNames[id] = ib ? ib.getString("name") : id;
    } catch (_) { inboxNames[id] = id; }
  }

  // Full allowed list (NOT the narrowed one) so the picker can offer every
  // mailbox the actor may report on, including "All".
  const allowedInboxes = [];
  try {
    const allowedIds = actor.isAdmin
      ? (($app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || []) || []).map((r) => r.id)
      : h.inboxIdsForUser(actor.recordId || actor.id).all;
    for (const id of allowedIds) {
      try {
        const ib = h.safeFindById("inboxes", id);
        allowedInboxes.push({ id: id, name: ib ? (ib.getString("name") || id) : id });
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* skip */ }

  const RANGE_LABEL = { week: "Last 7 days", month: "Last 30 days", quarter: "Last 90 days", year: "Last 12 months", all: "All time" };

  e.json(200, {
    ok: true,
    scope: {
      inbox: wantedInbox,                                   // "" = all mailboxes
      inboxName: wantedInbox ? (inboxNames[wantedInbox] || wantedInbox) : "All mailboxes",
      range: rangeKey,
      rangeLabel: RANGE_LABEL[rangeKey] || RANGE_LABEL.all,
      mailboxes: allowedInboxes.length,                     // count in scope
      since: cutoff > 0 ? new DateTime(cutoff * 1e9).toString() : ""
    },
    inboxes: allowedInboxes,
    totals: { threads: threads.length, open, closed, spamArchived },
    byStatus,
    sla: { total: totalSla, overdue: slaOverdue, dueSoon: slaDueSoon },
    csat: { responses: csatResponses, average: csatResponses ? Math.round((csatSum / csatResponses) * 10) / 10 : 0, pending: csatPending },
    responsiveness: {
      firstResponse: { count: frN, avgHours: frN ? Math.round((toHours(frSumNs) / frN) * 10) / 10 : 0 },
      resolution: { count: resN, avgHours: resN ? Math.round((toHours(resSumNs) / resN) * 10) / 10 : 0 }
    },
    byInbox: Object.keys(byInbox).map((id) => ({ id, name: inboxNames[id], count: byInbox[id] })),
    byAssignee: { total: agentRows.length > 0 ? agentRows : [], unassignedOpen: byAssignee["(unassigned)"] ? byAssignee["(unassigned)"].open : 0 },
    agents: agentRows,
    agentsMeta: { firstResponseAt: "first_response_at (agent first reply), closed_at (last close) — populated going forward" }
  });
}

module.exports = { handleReports };
