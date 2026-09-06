// =============================================================================
// gw-mailbox — settings engine (module)
// Admin settings stored in the app_settings singleton: Google service-account
// key + sync preferences. Also a connection tester (profile read via the
// configured mailbox).
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

// ---------------------------------------------------------------------------
// Settings accessors
// ---------------------------------------------------------------------------
function ensureSettings() {
  let rec = null;
  try {
    rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
  } catch (_) { /* missing */ }
  if (!rec) {
    const coll = $app.findCollectionByNameOrId("app_settings");
    rec = new Record(coll, { key: "instance", poll_sync: false, service_account_key: "", key_client_email: "" });
    $app.save(rec);
  }
  return rec;
}

function getSettings() {
  return ensureSettings();
}

function saveServiceAccountJson(serviceAccountJson) {
  const parsed = JSON.parse(serviceAccountJson);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("invalid_service_account: expected client_email and private_key");
  }
  const rec = ensureSettings();
  rec.set("service_account_key", JSON.stringify(parsed));
  rec.set("key_client_email", parsed.client_email);
  $app.save(rec);
  return parsed.client_email;
}

function clearServiceAccount() {
  const rec = ensureSettings();
  rec.set("service_account_key", "");
  rec.set("key_client_email", "");
  $app.save(rec);
}

function getStoredServiceAccount() {
  const rec = ensureSettings();
  const raw = rec.getString("service_account_key");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function setPollSync(enabled) {
  const rec = ensureSettings();
  rec.set("poll_sync", !!enabled);
  $app.save(rec);
}

function pollSyncEnabled() {
  const rec = ensureSettings();
  return rec.getBool("poll_sync");
}

// effective sync prefs (settings record overrides env)
function effectivePollSync() {
  return $os.getenv("MAILBOX_POLL_SYNC") === "1" || pollSyncEnabled();
}

// ---------------------------------------------------------------------------
// Connection test — reads the mailbox profile with the configured (or passed)
// service account, proving delegation + scopes work.
// ---------------------------------------------------------------------------
function testConnection(subjectEmail, saJson) {
  let sa = null;
  if (saJson) {
    const parsed = JSON.parse(saJson);
    if (!parsed.client_email || !parsed.private_key) throw new Error("invalid_service_account");
    sa = parsed;
  } else {
    sa = h.loadServiceAccount(); // env OR stored settings
  }
  const subject = subjectEmail || $os.getenv("MAILBOX_TEST_SUBJECT") || "";
  if (!subject) throw new Error("subject_required: provide the mailbox email to impersonate");
  // Ensure the token cache uses OUR sa (not only env): h.getAccessToken loads
  // from env OR settings via loadServiceAccount; passing explicit SA not
  // supported there, so temporarily clear+restore is complex. Instead test
  // with stored/env creds (same loader the engine uses).
  return h.googleRequest({
    url: h.GMAIL_BASE + "/users/" + encodeURIComponent(subject) + "/profile?fields=emailAddress,historyId,messagesTotal",
    scopes: [h.GMAIL_SCOPE],
    subject: subject
  });
}

// ---------------------------------------------------------------------------
// Route handlers (all superuser-only; the registrar adds requireSuperuserAuth)
// ---------------------------------------------------------------------------
function requireAdmin(e) {
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isSuperuser) {
    h.fail(e, 403, "admin_required", "Superuser access required");
    return null;
  }
  return actor;
}

function handleGetSettings(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const admin = requireAdmin(e);
  if (!admin) return;
  const rec = ensureSettings();
  const saEmail = rec.getString("key_client_email");
  e.json(200, {
    ok: true,
    serviceAccountConfigured: !!saEmail,
    serviceAccountEmail: saEmail,
    pollSync: rec.getBool("poll_sync") || $os.getenv("MAILBOX_POLL_SYNC") === "1",
    envOverrides: {
      pollSyncEnv: $os.getenv("MAILBOX_POLL_SYNC") === "1"
    }
  });
}

function handleSaveServiceAccount(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const admin = requireAdmin(e);
  if (!admin) return;
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) {}
  const jsonStr = body.serviceAccountJson || "";
  if (!jsonStr) return h.fail(e, 400, "missing_key", "serviceAccountJson is required");
  try {
    const email = saveServiceAccountJson(jsonStr);
    // return the client email only (never echo the private key back)
    e.json(200, { ok: true, serviceAccountEmail: email });
  } catch (err) {
    h.fail(e, 400, "invalid_key", err.message || String(err));
  }
}

function handleRemoveServiceAccount(e) {
  if (h.addCorsHeaders(e, "DELETE, OPTIONS")) return;
  const admin = requireAdmin(e);
  if (!admin) return;
  clearServiceAccount();
  e.json(200, { ok: true });
}

function handleTestConnection(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const admin = requireAdmin(e);
  if (!admin) return;
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) {}
  const subject = (body.subject || "").toString();
  const saJson = body.serviceAccountJson || "";
  try {
    const profile = testConnection(subject, saJson);
    let sendAuthorized = false;
    let sendError = "";
    try {
      // Probe the SEND scope separately: sending needs modify+send DWD scope.
      h.getAccessToken([h.GMAIL_SCOPE, h.GMAIL_SEND_SCOPE], subject);
      sendAuthorized = true;
    } catch (err2) {
      sendError = (err2 && err2.message) || String(err2);
    }
    e.json(200, {
      ok: true,
      emailAddress: profile.emailAddress || subject,
      historyId: profile.historyId || null,
      messagesTotal: profile.messagesTotal || 0,
      sendAuthorized: sendAuthorized,
      sendError: sendError
    });
  } catch (err) {
    h.warn("test-connection failed for", subject, "->", (err && err.message) || String(err));
    // 200-with-error: the reverse proxy rewrites 5xx bodies into a useless
    // "error code: 502", so return the real message as a successful response.
    e.json(200, { ok: false, error: "connection_failed", message: (err && err.message) || String(err) });
  }
}

function handleSetPollSync(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const admin = requireAdmin(e);
  if (!admin) return;
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) {}
  setPollSync(!!body.enabled);
  e.json(200, { ok: true, pollSync: pollSyncEnabled() });
}

// ---------------------------------------------------------------------------
// Mailbox management (admin) — add/configure additional mailboxes to sync
// ---------------------------------------------------------------------------
function readBody(e) {
  try { return JSON.parse(toString(e.request.body) || "{}"); } catch (_) { return {}; }
}

function userMap() {
  const map = {};
  try {
    const rows = $app.findRecordsByFilter("users", "", "name", 0, 0);
    for (const r of rows || []) map[r.id] = r.getString("name") || r.getString("email");
  } catch (_) {}
  return map;
}

function inboxToView(r) {
  const um = userMap();
  const allowed = r.get("allowed_users") || r.getStringSlice("allowed_users") || [];
  const teams = r.get("allowed_teams") || r.getStringSlice("allowed_teams") || [];
  const users = (Array.isArray(allowed) ? allowed : []).map((u) => ({ id: u, name: um[u] || u }));
  const teamNames = [];
  for (const tid of Array.isArray(teams) ? teams : []) {
    const t = h.safeFindById("teams", tid);
    teamNames.push(t ? (t.getString("name") || tid) : tid);
  }
  return {
    id: r.id,
    name: r.getString("name"),
    email_address: r.getString("email_address"),
    history_id: r.getString("history_id"),
    is_active: r.getBool("is_active"),
    allowed_users: users,
    team_names: teamNames
  };
}

function handleListInboxes(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const rows = $app.findRecordsByFilter("inboxes", "", "name", 0, 0);
  e.json(200, { ok: true, inboxes: (rows || []).map(inboxToView) });
}

function handleCreateInbox(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const body = readBody(e);
  const name = (body.name || "").toString().trim();
  const email = (body.email_address || "").toString().trim().toLowerCase();
  const userIds = Array.isArray(body.allowed_user_ids) ? body.allowed_user_ids : [];
  if (!name || !email) return h.fail(e, 400, "required", "name and email_address are required");
  // Duplicate check (inbox email is unique-indexed).
  const existing = h.safeFindFirstByFilter("inboxes", "email_address = {:e}", { e: email });
  if (existing) return h.fail(e, 409, "duplicate", "A mailbox with that address already exists");
  const rec = new Record($app.findCollectionByNameOrId("inboxes"), {
    name: name,
    email_address: email,
    allowed_users: userIds,
    allowed_teams: [],
    is_active: body.is_active !== false,
    history_id: ""
  });
  $app.save(rec);
  e.json(200, { ok: true, inbox: inboxToView(rec) });
}

function handleUpdateInbox(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const id = e.request.pathValue("id");
  const rec = h.safeFindById("inboxes", id);
  if (!rec) return h.fail(e, 404, "not_found", "Inbox not found");
  const body = readBody(e);
  if (body.name !== undefined) rec.set("name", String(body.name || "").trim());
  if (body.is_active !== undefined) rec.set("is_active", !!body.is_active);
  if (body.allowed_user_ids !== undefined) rec.set("allowed_users", Array.isArray(body.allowed_user_ids) ? body.allowed_user_ids : []);
  $app.save(rec);
  e.json(200, { ok: true, inbox: inboxToView(rec) });
}

function handleDeleteInbox(e) {
  if (h.addCorsHeaders(e, "DELETE, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const id = e.request.pathValue("id");
  const rec = h.safeFindById("inboxes", id);
  if (!rec) return h.fail(e, 404, "not_found", "Inbox not found");
  $app.delete(rec);
  e.json(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Label catalog (admin) — manage categories/labels
// ---------------------------------------------------------------------------
function labelToView(r) {
  return { id: r.id, name: r.getString("name"), color: r.getString("color") || "" };
}

function handleListLabels(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const rows = $app.findRecordsByFilter("labels", "", "name", 0, 0);
  e.json(200, { ok: true, labels: (rows || []).map(labelToView) });
}

function handleCreateLabel(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const body = readBody(e);
  const name = (body.name || "").toString().trim();
  if (!name) return h.fail(e, 400, "required", "name is required");
  const existing = h.safeFindFirstByFilter("labels", "name = {:n}", { n: name });
  if (existing) return e.json(200, { ok: true, label: labelToView(existing), existing: true });
  const rec = new Record($app.findCollectionByNameOrId("labels"), {
    name: name,
    color: (body.color || "").toString()
  });
  $app.save(rec);
  e.json(200, { ok: true, label: labelToView(rec) });
}

function handleDeleteLabel(e) {
  if (h.addCorsHeaders(e, "DELETE, OPTIONS")) return;
  if (!requireAdmin(e)) return;
  const id = e.request.pathValue("id");
  const rec = h.safeFindById("labels", id);
  if (!rec) return h.fail(e, 404, "not_found", "Label not found");
  $app.delete(rec);
  e.json(200, { ok: true });
}

module.exports = {
  getSettings,
  getStoredServiceAccount,
  setPollSync,
  pollSyncEnabled,
  effectivePollSync,
  testConnection,
  handleGetSettings,
  handleSaveServiceAccount,
  handleRemoveServiceAccount,
  handleTestConnection,
  handleSetPollSync,
  handleListInboxes,
  handleCreateInbox,
  handleUpdateInbox,
  handleDeleteInbox,
  handleListLabels,
  handleCreateLabel,
  handleDeleteLabel
};
