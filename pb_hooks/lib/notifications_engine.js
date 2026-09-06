// =============================================================================
// gw-mailbox — notifications engine (mentions / internal notes / assignments)
// Routes (registered in main.pb.js):
//   GET  /api/mailbox/notifications          — mine (unread first)
//   POST /api/mailbox/notifications/{id}/read — mark one read
//   POST /api/mailbox/notifications/read-all  — mark all mine read
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

function readBody(e) {
  try { return JSON.parse(toString(e.request.body) || "{}"); } catch (_) { return {}; }
}

function notify(recipientId, kind, threadId, subject, messageId, actorName, bodyText) {
  if (!recipientId) return null;
  try {
    const coll = $app.findCollectionByNameOrId("notifications");
    const rec = new Record(coll, {
      user: recipientId,
      kind: kind,
      thread: threadId || "",
      thread_subject: String(subject || "").slice(0, 500),
      message_id: messageId || "",
      actor_name: String(actorName || "").slice(0, 200),
      body_snippet: String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 300),
      read: false,
      created_at: new DateTime()
    });
    $app.save(rec);
    return rec;
  } catch (err) {
    h.warn("notify failed", recipientId, (err && err.message) || err);
    return null;
  }
}


// Superuser record ids that opted in to being @mentionable (read app_settings
// directly — avoids cross-module require in hook/runtime contexts).
function mentionableAdminIds() {
  try {
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    const v = rec.get("mention_admin_ids");
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}
// Scan an internal-note body for @mentions of teammates (by name or email)
// and notify each mentioned user (except the author). Optionally also notify
// the thread's assigned agent about a new note.
function notifyNoteMentions(threadRec, noteRec, actor, bodyText) {
  if (!threadRec || !noteRec) return;
  const threadId = threadRec.id;
  const subject = threadRec.getString("subject") || "(no subject)";
  const actorId = actor && (actor.recordId || actor.id);
  const haystack = String(bodyText || "").toLowerCase();

  // 1) @mentions (agents + opted-in admins)
  try {
    const users = $app.findRecordsByFilter("users", "", "name", 0, 0) || [];
    const targets = [];
    for (const u of users || []) {
      targets.push({ id: u.id, name: String(u.getString("name") || ""), email: String(u.getString("email") || "") });
    }
    // opted-in admins (superusers) — they are not in `users`
    try {
      const enabled = mentionableAdminIds();
      if (enabled.length) {
        const su = $app.findRecordsByFilter("_superusers", "", "", 0, 0) || [];
        for (const r of su || []) {
          if (enabled.indexOf(r.id) === -1) continue;
          targets.push({ id: r.id, name: r.getString("name") || "", email: String(r.getString("email") || "") });
        }
      }
    } catch (_) { /* non-fatal */ }

    for (const t of targets) {
      if (t.id === actorId) continue;
      const name = String(t.name || "").toLowerCase();
      const email = String(t.email || "").toLowerCase();
      const hit =
        (name && haystack.indexOf("@" + name) !== -1) ||
        (email && (haystack.indexOf("@" + email) !== -1 || haystack.indexOf(email) !== -1));
      if (hit) {
        notify(t.id, "mention", threadId, subject, noteRec.id, actor ? actor.name : "", bodyText);
      }
    }
  } catch (err) {
    h.warn("mention scan failed", (err && err.message) || err);
  }

  // 2) assigned agent gets a "note" notification when a note is added to
  //    their ticket (but not if they wrote it).
  const assignee = threadRec.getString("assigned_agent");
  if (assignee && assignee !== actorId) {
    notify(assignee, "note", threadId, subject, noteRec.id, actor ? actor.name : "", bodyText);
  }
}

// Route handlers -------------------------------------------------------------
function handleListNotifications(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const me = actor.recordId || actor.id;
  try {
    const rows = $app.findRecordsByFilter(
      "notifications",
      "user = {:u}",
      "-created_at",
      0,
      0,
      { u: me }
    );
    const out = (rows || []).map((r) => ({
      id: r.id,
      kind: r.getString("kind"),
      thread: r.getString("thread"),
      thread_subject: r.getString("thread_subject"),
      message_id: r.getString("message_id"),
      actor_name: r.getString("actor_name"),
      body_snippet: r.getString("body_snippet"),
      read: r.getBool("read"),
      created_at: r.getString("created_at")
    }));
    e.json(200, { ok: true, notifications: out });
  } catch (err) {
    e.json(200, { ok: false, error: "notif_list_failed", message: (err && err.message) || String(err) });
  }
}

function handleMarkRead(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const me = actor.recordId || actor.id;
  const id = e.request.pathValue("id");
  try {
    const rec = h.safeFindById("notifications", id);
    if (!rec) return h.fail(e, 404, "not_found", "Notification not found");
    if (rec.getString("user") !== me) return h.fail(e, 403, "forbidden", "Not yours");
    rec.set("read", true);
    $app.save(rec);
    e.json(200, { ok: true });
  } catch (err) {
    e.json(200, { ok: false, error: "notif_read_failed", message: (err && err.message) || String(err) });
  }
}

function handleMarkAllRead(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const me = actor.recordId || actor.id;
  try {
    const rows = $app.findRecordsByFilter("notifications", "user = {:u} && read = false", "", 0, 0, { u: me });
    for (const r of rows || []) {
      r.set("read", true);
      $app.save(r);
    }
    e.json(200, { ok: true, marked: (rows || []).length });
  } catch (err) {
    e.json(200, { ok: false, error: "notif_readall_failed", message: (err && err.message) || String(err) });
  }
}

module.exports = {
  notify,
  notifyNoteMentions,
  handleListNotifications,
  handleMarkRead,
  handleMarkAllRead
};
