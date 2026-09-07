// =============================================================================
// gw-mailbox — reporting engine
// Live aggregates over the inboxes the request actor can see (admins see all,
// agents see their inboxes). Returns status/assignee volume, open vs closed,
// SLA overdue count, CSAT average, and per-agent open/closed counts. Historical
// resolution time is limited (no created/closed stamps existed before this
// build) — but threads now carry first_response_at/closed_at going forward.
//
// Route (registered in main.pb.js): GET /api/mailbox/reports
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

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

  // Scope: all active inboxes for admins; permitted inboxes for agents.
  let inboxIds = [];
  try {
    if (actor.isSuperuser) {
      const all = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || [];
      inboxIds = (all || []).map((r) => r.id);
    } else {
      inboxIds = h.inboxIdsForUser(actor.recordId || actor.id).all;
    }
  } catch (_) { inboxIds = []; }
  const inboxSet = {};
  for (const id of inboxIds) inboxSet[id] = true;

  // Load every thread across those inboxes (each inbox's own records).
  const threads = [];
  for (const id of inboxIds) {
    try {
      const rows = $app.findRecordsByFilter("threads", "inbox = {:i}", "", 0, 0, { i: id }) || [];
      for (const r of rows) threads.push(r);
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
          const rt = r.getInt("rating") || 0;
          if (rt > 0) { csatResponses++; csatSum += rt; }
        } else {
          csatPending++;
        }
      }
    } catch (_) { /* skip */ }
  }

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

  e.json(200, {
    ok: true,
    totals: { threads: threads.length, open, closed, spamArchived },
    byStatus,
    sla: { total: totalSla, overdue: slaOverdue, dueSoon: slaDueSoon },
    csat: { responses: csatResponses, average: csatResponses ? Math.round((csatSum / csatResponses) * 10) / 10 : 0, pending: csatPending },
    byInbox: Object.keys(byInbox).map((id) => ({ id, name: inboxNames[id], count: byInbox[id] })),
    byAssignee: { total: agentRows.length > 0 ? agentRows : [], unassignedOpen: byAssignee["(unassigned)"] ? byAssignee["(unassigned)"].open : 0 },
    agents: agentRows,
    agentsMeta: { firstResponseAt: "first_response_at (agent first reply), closed_at (last close) — populated going forward" }
  });
}

module.exports = { handleReports };
