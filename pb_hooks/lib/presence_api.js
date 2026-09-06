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
  if (!actor.isSuperuser) {
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
  if (!text) return h.fail(e, 400, "empty_note", "Note body is required");

  const note = h.addInternalNote(threadId, actor, text, { source: "agent_note" });
  if (!note) return h.fail(e, 404, "thread_not_found", "Thread not found");

  e.json(200, {
    ok: true,
    note: {
      id: note.id,
      thread: note.getString("thread"),
      sender_email: note.getString("sender_email"),
      body_plain: note.getString("body_plain"),
      is_internal_note: true,
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
  thread.set("status", status);
  if (body.assigned_agent !== undefined) {
    if (body.assigned_agent === "" || body.assigned_agent === null) thread.set("assigned_agent", "");
    else thread.set("assigned_agent", body.assigned_agent);
  }
  if (body.tags !== undefined) thread.set("tags", Array.isArray(body.tags) ? body.tags : []);

  $app.save(thread);

  // Closed card -> drop the agent's composer lock so nobody is left "drafting".
  if (status === "closed" && actor.id) h.releasePresence(threadId, actor.id);

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

  if (actor.isSuperuser) {
    const all = $app.findRecordsByFilter("inboxes", "is_active = true", "name", 0, 0);
    e.json(200, { ok: true, me: actor, inboxes: (all || []).map(inboxSummary) });
    return;
  }

  const inboxIds = h.inboxIdsForUser(actor.id).all;
  const inboxes = inboxIds.length ? $app.findRecordsByIds("inboxes", inboxIds) : [];
  e.json(200, {
    ok: true,
    me: {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      googleEmail: actor.googleEmail || ""
    },
    inboxes: (inboxes || []).filter((r) => r && r.getBool("is_active")).map(inboxSummary)
  });
}

module.exports = {
  handlePresenceHeartbeat,
  handlePresenceRelease,
  handlePresenceSnapshot,
  handleAddInternalNote,
  handleMoveThread,
  handleMe
};
