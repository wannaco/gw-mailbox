// =============================================================================
// gw-mailbox — presence/notes/move/me API handlers (module)
//
// IMPORTANT (PB 0.39 quirk): functions registered via routerAdd/cronAdd/hooks
// execute in a context where top-level bindings from the .pb.js file are NOT
// visible. Handlers are therefore implemented INSIDE modules (whose closure
// scope is retained) and only thin registration code lives in main.pb.js.
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

function readJsonBody(e) {
  try {
    const raw = toString(e.request.body);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function inboxSummary(r) {
  return {
    id: r.id,
    name: r.getString("name"),
    email_address: r.getString("email_address"),
    history_id: r.getString("history_id"),
    is_active: r.getBool("is_active")
  };
}

// ---------------------------------------------------------------------------
// Presence heartbeat — Agent A marks composing_reply, every viewer learns
// about it through the returned `lock` + the thread_presence SSE broadcast.
// ---------------------------------------------------------------------------
function handlePresenceHeartbeat(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const body = readJsonBody(e);
  const status = body.status || "viewing";
  if (["viewing", "composing_reply"].indexOf(status) === -1) {
    return h.fail(e, 400, "invalid_status", "status must be viewing|composing_reply");
  }
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;

  // BREAK-GLASS SUPERUSERS are observe-only: they have no `users` record, so
  // there is nothing to persist a row against — but they still get the lock +
  // snapshot so the draft banner works while an ops token is watching.
  //
  // This branch used to test `isAdmin`, which is ALSO true for app admins
  // (users.role === 'admin'). Those are ordinary users with a real record, and
  // being treated as observe-only meant an admin never published presence at
  // all: nobody could see the admin on a thread, and the admin's own drafting
  // never locked anyone else out. Gate on isSuperuser, which is the thing that
  // actually has no users record.
  if (actor.isSuperuser) {
    const lock = h.composingLock(threadId, "");
    return e.json(200, {
      ok: true,
      changed: false,
      lock: lock ? { agentName: lock.agentName, userId: lock.userId } : null,
      presence: h.presenceSnapshot(threadId)
    });
  }

  const res = h.heartbeatPresence(threadId, actor.id, status);
  e.json(200, {
    ok: true,
    changed: res.changed,
    // Non-null when ANOTHER agent is composing -> UI shows the banner and
    // disables reply/meet actions ("Agent A is drafting a reply").
    lock: res.lock ? { agentName: res.lock.agentName, userId: res.lock.userId } : null,
    presence: h.presenceSnapshot(threadId)
  });
}

function handlePresenceRelease(e) {
  if (h.addCorsHeaders(e, "DELETE, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;

  h.releasePresence(threadId, actor.id);
  e.json(200, { ok: true, presence: h.presenceSnapshot(threadId) });
}

function handlePresenceSnapshot(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  if (!actor.isAdmin) {
    const access = h.requireThreadAccess(e, threadId, actor);
    if (!access) return;
  }
  e.json(200, { ok: true, presence: h.presenceSnapshot(threadId) });
}

// ---------------------------------------------------------------------------
// Internal notes (@mention team notes live in the same messages stream)
// ---------------------------------------------------------------------------
function handleAddInternalNote(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;

  const body = readJsonBody(e);
  const text = (body.body || body.text || "").toString().trim();
  const html = (body.html || "").toString().trim();
  if (!text && !html) return h.fail(e, 400, "empty_note", "Note body is required");

  const note = h.addInternalNote(threadId, actor, text, {
    source: "agent_note",
    html: html ? h.sanitizeHtmlBasic(html) : ""
  });
  if (!note) return h.fail(e, 404, "thread_not_found", "Thread not found");

  e.json(200, {
    ok: true,
    note: {
      id: note.id,
      thread: note.getString("thread"),
      sender_email: note.getString("sender_email"),
      body_plain: note.getString("body_plain"),
      is_internal_note: true,
      msg_date: note.getString("msg_date"),
      created: note.getDateTime("created").string()
    }
  });
}

// ---------------------------------------------------------------------------
// Kanban card moves (server-validated status transitions)
// ---------------------------------------------------------------------------
function handleMoveThread(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;

  const body = readJsonBody(e);
  const status = (body.status || "").toString();
  if (h.THREAD_STATUSES.indexOf(status) === -1) {
    return h.fail(e, 400, "invalid_status", "status must be one of: " + h.THREAD_STATUSES.join(", "));
  }

  const thread = access.thread;
  const prev = thread.getString("status");
  thread.set("status", status);
  // Entering waiting_customer starts a FRESH follow-up/auto-close window.
  if (status === "waiting_customer" && prev !== "waiting_customer") {
    try {
      require(__hooks + "/lib/automations_engine.js").resetFollowups(thread);
    } catch (_) { /* non-fatal */ }
  }
  // Remembered before the write so we can tell whether the owner CHANGED.
  const prevAssignee = thread.getString("assigned_agent");
  if (body.assigned_agent !== undefined) {
    if (body.assigned_agent === "" || body.assigned_agent === null) thread.set("assigned_agent", "");
    else thread.set("assigned_agent", body.assigned_agent);
  }
  if (body.tags !== undefined) thread.set("tags", Array.isArray(body.tags) ? body.tags : []);
  // Rescuing a thread out of spam gives it a FRESH clock rather than the stale
  // one it carried while classified as junk (see resetSlaDeadline).
  if (prev === "spam" && status !== "spam") h.resetSlaDeadline(thread);
  // Moving INTO an active column starts the first-response clock if the thread
  // has none (imported history and archived threads carry no deadline).
  if (h.SLA_ACTIVE_STATUSES.indexOf(status) !== -1) h.ensureSlaDeadline(thread);

  $app.save(thread);

  // Tell the agent a ticket was just handed to them.
  //
  // Fires only on a CHANGE of owner: re-saving the same assignee (which the UI
  // does as part of other edits) must not re-notify, and assigning YOURSELF is
  // never worth telling you about.
  try {
    const nowAssignee = thread.getString("assigned_agent");
    if (nowAssignee && nowAssignee !== prevAssignee && nowAssignee !== actor.id) {
      require(__hooks + "/lib/notifications_engine.js").notify(
        nowAssignee,
        "assigned",
        thread.id,
        thread.getString("subject") || "(no subject)",
        "",
        actor.name || "",
        "Assigned to you by " + (actor.name || "a teammate")
      );
    }
  } catch (err) {
    h.warn("assign notification failed", (err && err.message) || err);
  }

  // Closed card -> drop the agent's composer lock so nobody is left "drafting".
  if (status === "closed" && actor.id) h.releasePresence(threadId, actor.id);
  // Entering closed -> fire the CSAT survey to the customer (auto-send on close).
  if (status === "closed" && prev !== "closed") {
    try { require(__hooks + "/lib/csat_engine.js").dispatchCsatOnClose(threadId); } catch (_) { /* non-fatal */ }
  }
  // Entering closed -> stamp closed_at for reports.
  if (status === "closed" && prev !== "closed") h.markThreadClosed(thread);

  e.json(200, {
    ok: true,
    threadId: thread.id,
    status: thread.getString("status"),
    assigned_agent: thread.getString("assigned_agent"),
    tags: thread.getStringSlice("tags") || thread.get("tags") || []
  });
}

// ---------------------------------------------------------------------------
// GET /api/mailbox/me — agent profile + permitted inboxes (UI bootstrap)
// ---------------------------------------------------------------------------
function handleMe(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  // Break-glass ops token (PB dashboard / CLI / ops scripts). NOTE: this is the
  // ONLY branch gated on isSuperuser — app admins are ordinary users records and
  // must fall through to the app branch below so they get role/isAdmin and their
  // own signature.
  if (actor.isSuperuser) {
    const all = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0);
    let sig = "";
    let sigAuto = false;
    try {
      const su = actor.recordId ? h.safeFindById("_superusers", actor.recordId) : null;
      if (su) {
        sig = su.getString("signature") || "";
        sigAuto = su.getBool("signature_auto");
      }
    } catch (_) { /* field may not exist on older rows */ }
    e.json(200, {
      ok: true,
      me: { id: actor.id, name: actor.name, email: actor.email, isSuperuser: true, isAdmin: true, signature: sig, signature_auto: sigAuto },
      inboxes: (all || []).map(inboxSummary),
      sla: h.readSlaConfig()
    });
    return;
  }

  // App admin (users.role = admin) manages every active inbox; an agent only the
  // inboxes they were granted.
  let inboxIds;
  if (actor.isAdmin) {
    inboxIds = ($app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0) || []).map((r) => r.id);
  } else {
    inboxIds = h.inboxIdsForUser(actor.id).all;
  }
  const inboxes = inboxIds.length ? $app.findRecordsByIds("inboxes", inboxIds) : [];
  // Signature fields come from the user's OWN record. App admins are ordinary
  // `users` records too (role=admin), so only a break-glass superuser token has
  // no users record to read from.
  const rec = actor.isSuperuser ? null : h.safeFindById("users", actor.id);
  e.json(200, {
    ok: true,
    me: {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      role: actor.role || "agent",
      isAdmin: !!actor.isAdmin,
      googleEmail: actor.googleEmail || "",
      signature: rec ? (rec.getString("signature") || "") : "",
      signature_auto: rec ? rec.getBool("signature_auto") : false
    },
    inboxes: (inboxes || []).filter((r) => r && r.getBool("is_active")).map(inboxSummary),
    sla: h.readSlaConfig()
  });
}

// POST /api/mailbox/me/signature — the signed-in user (agent OR admin) saves
// their own signature + auto-insert flag. Both live in `users` (admins are
// role=admin); only a break-glass superuser token writes to `_superusers`.
function handleSaveMySignature(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) { body = {}; }
  // The browser only ever authenticates as an app user (users.role), so
  // signatures live on the users record. The _superusers branch remains only
  // for break-glass ops tokens (dashboard/CLI scripts).
  const coll = actor.isSuperuser ? "_superusers" : "users";
  const uid = actor.isSuperuser ? (actor.recordId || actor.id) : actor.id;
  const rec = h.safeFindById(coll, uid);
  if (!rec) return h.fail(e, 404, "not_found", "User record not found");
  if (body.signature !== undefined) rec.set("signature", String(body.signature || "").slice(0, 8000));
  if (body.signature_auto !== undefined) rec.set("signature_auto", !!body.signature_auto);
  $app.save(rec);
  e.json(200, {
    ok: true,
    signature: rec.getString("signature") || "",
    signature_auto: rec.getBool("signature_auto")
  });
}

// ---------------------------------------------------------------------------
// GET /api/mailbox/users — team directory for @mentions / assignee names
// ---------------------------------------------------------------------------

// Opted-in admins (stored as {id,name,email} objects in app_settings).
function mentionableAdmins() {
  try {
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    const raw = rec.getString("mention_admin_ids");
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && x.id) : [];
  } catch (_) { return []; }
}
function handleDirectory(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  // NOTE: this PB fork's signature is findRecordsByFilter(collection, filter,
  // sort, limit, offset, params) — limit then offset. limit 0 = no limit.
  const rows = $app.findRecordsByFilter("users", "", "name", 0, 0);
  const users = (rows || []).map((r) => ({
    id: r.id,
    name: r.getString("name"),
    email: r.getString("email"),
    kind: "agent",
    signature: r.getString("signature") || "",
    signature_auto: r.getBool("signature_auto")
  }));
  // Opted-in admins (superusers) are included so agents can @mention them.
  // Entries come pre-stored (id/name/email) — no _superusers query needed here.
  try {
    const admins = mentionableAdmins();
    for (const a of admins) {
      const email = a.email || "";
      if (!users.find((u) => u.email === email)) {
        users.push({ id: a.id, name: a.name || email, email: email, kind: "admin" });
      }
    }
  } catch (_) { /* settings row may not exist yet */ }
  e.json(200, { ok: true, users: users });
}

// ---------------------------------------------------------------------------
// App-wide presence roster (see migration 1786000007). Heartbeat every ~8s
// while the app is visible; delete on tab hide/close.
// ---------------------------------------------------------------------------
function actorRow(actor, threadId, status) {
  // One row per actor, upserted server-side (rules close the API to clients).
  let row = null;
  try {
    row = $app.findFirstRecordByFilter(
      "agent_presence",
      "actor = {:a}",
      { a: actor.recordId || actor.id }
    );
  } catch (_) { /* not found */ }
  if (!row) {
    row = new Record($app.findCollectionByNameOrId("agent_presence"), {
      actor: actor.recordId || actor.id,
      kind: actor.isAdmin ? "admin" : "agent",   // app role, not the PB superuser
      name: actor.name || actor.email || "",
      email: actor.email || "",
      status: status || "online"
    });
  } else {
    row.set("status", status || "online");
  }
  row.set("updated_at", new DateTime());

  // Resolve current thread -> subject + inbox (subject only when permitted).
  if (threadId) {
    const t = h.safeFindById("threads", threadId);
    if (t) {
      const canView = actor.isAdmin || h.canViewThreadForUser(t, actor.recordId || actor.id);
      row.set("thread", threadId);
      row.set("inbox", t.getString("inbox") || "");
      row.set("thread_subject", canView ? (t.getString("subject") || "(no subject)") : "");
    } else {
      row.set("thread", "");
      row.set("inbox", "");
      row.set("thread_subject", "");
    }
  } else {
    row.set("thread", "");
    row.set("inbox", "");
    row.set("thread_subject", "");
  }
  $app.save(row);
  return row;
}

// Fresh roster (heartbeats within the last 25s) for every online teammate,
// EXCLUDING the requesting actor (they already know their own state).
function handlePresenceBeat(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const body = readJsonBody(e);
  const threadId = (body.thread || "").toString();
  const status = ["viewing", "composing_reply", "online"].indexOf(body.status) !== -1
    ? body.status
    : threadId ? "viewing" : "online";

  try {
    actorRow(actor, threadId, status);
  } catch (err) {
    h.warn("presence beat failed", actor.email, (err && err.message) || err);
  }
  e.json(200, { ok: true });
}

function handlePresenceOffline(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const key = actor.recordId || actor.id;
  try {
    const row = $app.findFirstRecordByFilter("agent_presence", "actor = {:a}", { a: key });
    if (row) $app.delete(row);
  } catch (_) { /* nothing to clear */ }
  e.json(200, { ok: true });
}

function handleRoster(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const cutoff = new DateTime().add(-180 * 1e9); // 3 minutes (hidden tabs beat less often)
  // NOTE: this PB fork's signature is findRecordsByFilter(collection, filter,
  // sort, limit, offset, params) — limit 0 = no limit, then offset 0.
  const rows = $app.findRecordsByFilter(
    "agent_presence",
    "updated_at >= {:cutoff}",
    "-updated_at",
    0,
    0,
    { cutoff: cutoff.string() }
  );
  const me = actor.recordId || actor.id;
  const roster = (rows || [])
    .filter((r) => r.getString("actor") !== me)
    .map((r) => ({
      actor: r.getString("actor"),
      kind: r.getString("kind"),
      name: r.getString("name"),
      email: r.getString("email"),
      status: r.getString("status"),
      thread: r.getString("thread"),
      thread_subject: r.getString("thread_subject"),
      inbox: r.getString("inbox")
    }));
  e.json(200, { ok: true, roster });
}

// ---------------------------------------------------------------------------
// Bulk thread actions (multi-select cleanup) — status moves OR hard delete.
//   POST /api/mailbox/threads/bulk   body: { ids: [], action }
//   action = a THREAD_STATUSES value (close/spam/archive/...)  OR "delete"
// Each id is access-checked independently; delete is superuser-only (it
// cascades to the thread's messages + notifications + presence rows).
// ---------------------------------------------------------------------------
function handleBulkThreads(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const body = readJsonBody(e);
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
  const action = (body.action || "").toString().trim();
  if (!ids.length) return h.fail(e, 400, "empty_selection", "No thread ids given");
  if (action !== "delete" && h.THREAD_STATUSES.indexOf(action) === -1) {
    return h.fail(e, 400, "invalid_action", "action must be a status (" + h.THREAD_STATUSES.join(", ") + ") or 'delete'");
  }

  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const thread = h.safeFindById("threads", id);
    if (!thread) { results.push({ id, ok: false, error: "not_found" }); continue; }
    const allowed = actor.isAdmin || h.canViewThreadForUser(thread, actor.recordId || actor.id);
    if (!allowed) { results.push({ id, ok: false, error: "forbidden" }); continue; }

    try {
      if (action === "delete") {
        if (!actor.isAdmin) { results.push({ id, ok: false, error: "admin_required" }); continue; }
        // Cascade: messages (incl internal notes), notifications, presence rows.
        const msgs = $app.findRecordsByFilter("messages", "thread = {:t}", "", 0, 0, { t: id }) || [];
        for (const m of msgs || []) { try { $app.delete(m); } catch (_) {} }
        const notifs = $app.findRecordsByFilter("notifications", "thread = {:t}", "", 0, 0, { t: id }) || [];
        for (const n of notifs || []) { try { $app.delete(n); } catch (_) {} }
        const pres = $app.findRecordsByFilter("thread_presence", "thread = {:t}", "", 0, 0, { t: id }) || [];
        for (const p of pres || []) { try { $app.delete(p); } catch (_) {} }
        $app.delete(thread);
        results.push({ id, ok: true, deleted: true });
      } else {
        const prev = thread.getString("status");
        thread.set("status", action);
        // Entering waiting_customer starts a FRESH follow-up/auto-close window.
        if (action === "waiting_customer" && prev !== "waiting_customer") {
          try { require(__hooks + "/lib/automations_engine.js").resetFollowups(thread); } catch (_) {}
        }
        // Same rescue rule as the single-thread move: out of spam means a fresh
        // clock, otherwise the stale deadline escalates it immediately.
        if (prev === "spam" && action !== "spam") h.resetSlaDeadline(thread);
        // Bulk move into an active column gets a clock too, same rule as the
        // single-thread move — otherwise the two paths behave differently.
        if (h.SLA_ACTIVE_STATUSES.indexOf(action) !== -1) h.ensureSlaDeadline(thread);
        $app.save(thread);
        if (action === "closed" && actor.recordId) h.releasePresence(id, actor.recordId);
        // Entering closed -> fire CSAT survey to the customer.
        if (action === "closed" && prev !== "closed") {
          try { require(__hooks + "/lib/csat_engine.js").dispatchCsatOnClose(id); } catch (_) { /* non-fatal */ }
        }
        // Entering closed -> stamp closed_at for reports.
        if (action === "closed" && prev !== "closed") h.markThreadClosed(thread);
        results.push({ id, ok: true, status: action });
      }
    } catch (err) {
      results.push({ id, ok: false, error: (err && err.message) || String(err) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  e.json(200, { ok: true, processed: okCount, failed: results.length - okCount, results });
}

module.exports = {
  handlePresenceHeartbeat,
  handlePresenceRelease,
  handlePresenceSnapshot,
  handleAddInternalNote,
  handleMoveThread,
  handleBulkThreads,
  handleSaveMySignature,
  handleMe,
  handleDirectory,
  handlePresenceBeat,
  handlePresenceOffline,
  handleRoster
};
