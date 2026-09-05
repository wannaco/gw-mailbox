// =============================================================================
// gw-mailbox — shared helpers (loaded from every pb_hooks/*.pb.js file)
//
// RUNTIME: PocketBase 0.39 pb_hooks (goja). ES6-ish but conservative.
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GMAIL_SCOPE      = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const CAL_SCOPE    = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_BASE   = "https://gmail.googleapis.com/gmail/v1";
const CAL_BASE     = "https://www.googleapis.com/calendar/v3";

const THREAD_STATUSES = ["new", "in_progress", "waiting_customer", "escalated", "closed"];

const log = (...args) => console.log("[gw-mailbox]", ...args);
const warn = (...args) => console.warn("[gw-mailbox]", ...args);

// ---------------------------------------------------------------------------
// HTTP / CORS helpers (PB 0.39: response.header().set(...))
// ---------------------------------------------------------------------------
function addCorsHeaders(e, methods) {
  methods = methods || "GET, POST, DELETE, OPTIONS";
  try {
    const hdr = e.response.header();
    const allowed = $os.getenv("MAILBOX_ALLOWED_ORIGIN") || "";
    const origin = e.request.header("Origin");
    if (allowed && origin === allowed) {
      hdr.set("Access-Control-Allow-Origin", origin);
      hdr.set("Vary", "Origin");
    } else if (!allowed && origin) {
      const host = e.request.host();
      if (origin.indexOf("//" + host) !== -1) hdr.set("Access-Control-Allow-Origin", origin);
    }
    hdr.set("Access-Control-Allow-Methods", methods);
    hdr.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  } catch (_) {}
  if (e.request.method === "OPTIONS") { e.noContent(204); return true; }
  return false;
}

function fail(e, status, code, message, extra) {
  const body = { error: code || "error", message: message || String(message) };
  if (extra) Object.assign(body, extra);
  e.json(status, body);
}

// Actor object from a request event (used for internal notes + audit).
function actorFromEvent(e) {
  if (e.hasSuperuserAuth && e.hasSuperuserAuth()) {
    return { id: "superuser", name: "Admin", email: "admin@local", isSuperuser: true };
  }
  if (e.auth) {
    return {
      id: e.auth.id,
      name: e.auth.getString("name") || e.auth.getString("email"),
      email: e.auth.getString("email"),
      googleEmail: e.auth.getString("googleEmail") || "",
      isSuperuser: false
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------
function safeFindById(collection, id) {
  try { return $app.findRecordById(collection, id); } catch (_) { return null; }
}

function safeFindFirstByFilter(collection, filter, params) {
  try { return $app.findFirstRecordByFilter(collection, filter, params || {}); } catch (_) { return null; }
}

function inboxIdsForUser(userId) {
  // Direct memberships
  const direct = [];
  const inboxes = $app.findRecordsByFilter("inboxes", "allowed_users ~ {:uid}", "", 0, 0, { uid: userId });
  for (const r of inboxes || []) direct.push(r.id);
  // Memberships via teams (an agent may belong to several teams)
  const viaTeams = new Set();
  const teams = $app.findRecordsByFilter("teams", "members ~ {:uid}", "", 0, 0, { uid: userId });
  const teamIds = (teams || []).map((t) => t.id);
  for (const tid of teamIds) {
    const inboxes2 = $app.findRecordsByFilter("inboxes", "allowed_teams ~ {:tid}", "", 0, 0, { tid: tid });
    for (const r of inboxes2 || []) viaTeams.add(r.id);
  }
  return { direct, viaTeams: Array.from(viaTeams), all: Array.from(new Set([...direct, ...viaTeams])) };
}

// Can the given userId view a thread record? Mirrors the collection rules in
// the migration so custom endpoints never leak cross-inbox data.
function canViewThreadForUser(threadRec, userId) {
  if (!threadRec) return false;
  const inboxId = threadRec.getString("inbox");
  const inbox = safeFindById("inboxes", inboxId);
  if (!inbox || !inbox.getBool("is_active")) return false;

  if ((inbox.getStringSlice("allowed_users") || []).indexOf(userId) !== -1) return true;

  const teamIds = inbox.getStringSlice("allowed_teams") || [];
  for (const tid of teamIds) {
    const team = safeFindById("teams", tid);
    if (team && (team.getStringSlice("members") || []).indexOf(userId) !== -1) return true;
  }
  return false;
}

// Load a thread + enforce access for the request actor.
// Returns { thread } or null (after writing the error response).
function requireThreadAccess(e, threadId, actor) {
  const thread = safeFindById("threads", threadId);
  if (!thread) { fail(e, 404, "thread_not_found", "Thread not found"); return null; }
  if (actor.isSuperuser) return { thread };
  if (!canViewThreadForUser(thread, actor.id)) { fail(e, 403, "forbidden", "No access to this thread"); return null; }
  return { thread };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function nowDateTime() { return new DateTime(); }

// PB date-layout string (e.g. "2026-09-05 15:13:19.123Z") — always parseable
// by PB filters and date fields.
function dateToPbString(d) {
  try { return d.string(); } catch (_) { return ""; }
}

function isoToPbString(iso) {
  try { return new DateTime(iso).string(); } catch (_) { return new DateTime().string(); }
}

// true when thread.sla_due_at <= now (breached)
function isSlaBreached(threadRec) {
  const due = threadRec.getDateTime("sla_due_at");
  if (!due || due.isZero()) return false;
  return due.before(new DateTime());
}

// ---------------------------------------------------------------------------
// Internal notes (messages with is_internal_note=true, no gmail id)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Adds an internal note to a thread and bumps thread.updated so the SSE
// stream wakes all open viewers. Does NOT touch last_message_at (that field
// tracks real customer email traffic).
function addInternalNote(threadId, actor, bodyText, meta) {
  const thread = safeFindById("threads", threadId);
  if (!thread) return null;
  const coll = $app.findCollectionByNameOrId("messages");
  const html = "<p><strong>Internal note</strong></p><p>" + escapeHtml(bodyText) + "</p>";
  const note = new Record(coll, {
    thread: threadId,
    sender_email: actor ? (actor.email || "system@mailbox.local") : "system@mailbox.local",
    recipient_emails: [],
    body_html: html,
    body_plain: bodyText || "",
    is_internal_note: true
  });
  $app.save(note);
  log("internal note added", threadId, "by", actor ? actor.name : "system");
  return note;
}

// ---------------------------------------------------------------------------
// Presence engine (collision prevention + draft locks)
// ---------------------------------------------------------------------------
// NOTE: DateTime.sub() returns a Go time.Duration = NANOSECONDS.
const PRESENCE_MAX_AGE_NS = 10 * 60 * 1e9;   // hard cap; cron sweeps at 2 min
const PRESENCE_THROTTLE_NS = 4e9;            // don't re-broadcast identical heartbeats

function presenceCollection() {
  return $app.findCollectionByNameOrId("thread_presence");
}

function findPresence(threadId, userId) {
  return safeFindFirstByFilter(
    "thread_presence",
    "thread = {:t} && user = {:u}",
    { t: threadId, u: userId }
  );
}

// Who else (not `userId`) is composing on this thread right now?
function composingLock(threadId, excludeUserId) {
  const rows = $app.findRecordsByFilter(
    "thread_presence",
    "thread = {:t} && status = {:s} && user != {:u}",
    "-updated_at",
    0,
    0,
    { t: threadId, s: "composing_reply", u: excludeUserId || "" }
  );
  for (const row of rows || []) {
    const fresh = nowDateTime().sub(row.getDateTime("updated_at")) < PRESENCE_MAX_AGE_NS;
    if (fresh) {
      const user = safeFindById("users", row.getString("user"));
      return {
        id: row.id,
        userId: row.getString("user"),
        agentName: user ? (user.getString("name") || user.getString("email")) : "Another agent",
        agentEmail: user ? user.getString("email") : "",
        status: "composing_reply"
      };
    }
  }
  return null;
}

// Heartbeat called by the client on an interval:
//   heartbeatPresence(threadId, userId, status)
// Returns { ok, changed, lock } — `lock` is non-null when ANOTHER agent is
// currently composing (Agent B must show "Agent A is drafting a reply").
function heartbeatPresence(threadId, userId, status) {
  const coll = presenceCollection();
  const now = nowDateTime();
  let row = findPresence(threadId, userId);

  if (!row) {
    row = new Record(coll, { thread: threadId, user: userId, status: status, updated_at: now });
    $app.save(row);
    return { ok: true, changed: true, lock: composingLock(threadId, userId) };
  }

  // Throttle identical heartbeats — avoids SSE spam for a "viewing" state that
  // never changes. Status transitions (viewing -> composing_reply) always flush.
  const elapsedNs = now.sub(row.getDateTime("updated_at"));
  const sameStatus = row.getString("status") === status;
  if (sameStatus && elapsedNs < PRESENCE_THROTTLE_NS) {
    return { ok: true, changed: false, lock: composingLock(threadId, userId) };
  }

  row.set("status", status);
  row.set("updated_at", now);
  $app.save(row);
  return { ok: true, changed: true, lock: composingLock(threadId, userId) };
}

function releasePresence(threadId, userId) {
  const row = findPresence(threadId, userId);
  if (row) $app.delete(row);
  return { ok: true };
}

// Snapshot of everyone currently on the thread (viewers + composers).
function presenceSnapshot(threadId) {
  const rows = $app.findRecordsByFilter("thread_presence", "thread = {:t}", "-updated_at", 0, 0, { t: threadId });
  const out = [];
  for (const row of rows || []) {
    if (nowDateTime().sub(row.getDateTime("updated_at")) > PRESENCE_MAX_AGE_NS) continue;
    const user = safeFindById("users", row.getString("user"));
    out.push({
      id: row.id,
      userId: row.getString("user"),
      agentName: user ? (user.getString("name") || user.getString("email")) : "Unknown",
      status: row.getString("status"),
      updatedAt: dateToPbString(row.getDateTime("updated_at"))
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google service-account auth (domain-wide delegation)
// ---------------------------------------------------------------------------
// Credentials come from the environment (see .env.example):
//   GOOGLE_SA_JSON  — inline service-account JSON, OR
//   GOOGLE_SA_FILE  — path to the JSON file
//   GOOGLE_SIGNER_URL — optional RS256 signer sidecar (POST {claim, privateKey}
//                       -> {signedJwt}). Defaults to http://localhost:9999/sign
//                       to match the repo's Go signer; falls back to openssl.
// ---------------------------------------------------------------------------
function b64urlFromStandard(b64) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Manual base64 encode/decode — atob/btoa are NOT available in module scope
// when invoked through PB 0.39 router handlers.
function b64EncodeBytes(bin) {
  let out = "";
  for (let i = 0; i < bin.length; i += 3) {
    const c1 = bin.charCodeAt(i);
    const c2 = i + 1 < bin.length ? bin.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < bin.length ? bin.charCodeAt(i + 2) : NaN;
    const b1 = c1 >> 2;
    const b2 = ((c1 & 3) << 4) | ((isNaN(c2) ? 0 : c2) >> 4);
    const b3 = (isNaN(c2) ? 64 : ((c2 & 15) << 2) | ((isNaN(c3) ? 0 : c3) >> 6));
    const b4 = isNaN(c3) ? 64 : (c3 & 63);
    out += B64_CHARS.charAt(b1) + B64_CHARS.charAt(b2) +
      B64_CHARS.charAt(b3) + B64_CHARS.charAt(b4);
  }
  return out;
}

function b64urlEncode(str) {
  // ASCII-safe input (JSON header/payload)
  return b64urlFromStandard(b64EncodeBytes(str));
}

function bytesToBinaryString(data) {
  if (typeof data === "string") return data;
  let s = "";
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  return s;
}

function b64urlEncodeBinary(data) {
  return b64urlFromStandard(b64EncodeBytes(bytesToBinaryString(data)));
}

// Decode (standard or URL-safe) base64 into a UTF-8 string without atob.
function b64DecodeUtf8(b64) {
  let s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  let bin = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "=") break;
    const idx = B64_CHARS.indexOf(ch);
    if (idx === -1) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bin += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  // decode UTF-8 bytes -> string
  const bytes = [];
  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; }
    else if ((b >> 5) === 0x6 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2;
    }
    else if ((b >> 4) === 0xe && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3;
    }
    else if ((b >> 3) === 0x1e && i + 3 < bytes.length) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += 4;
    } else i++;
  }
  return out;
}

function loadServiceAccount() {
  let raw = $os.getenv("GOOGLE_SA_JSON") || "";
  if (!raw) {
    const file = $os.getenv("GOOGLE_SA_FILE") || "";
    if (!file) {
      // Fall back to the admin-stored key (Settings UI).
      try {
        const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
        raw = rec.getString("service_account_key") || "";
      } catch (_) {
        raw = "";
      }
    } else {
      raw = toString($os.readFile(file));
    }
  }
  if (!raw) throw new Error("GOOGLE_SA_JSON / GOOGLE_SA_FILE not configured");
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error("invalid service account file");
  return sa;
}

function signJwtRs256(claim, privateKeyPem) {
  // 1) Sidecar signer (same contract as the repo's Go sidecar).
  const signerUrl = $os.getenv("GOOGLE_SIGNER_URL") || "http://localhost:9999/sign";
  try {
    const resp = $http.send({
      url: signerUrl,
      method: "POST",
      body: JSON.stringify({ claim: claim, privateKey: privateKeyPem }),
      headers: { "Content-Type": "application/json" },
      timeout: 10
    });
    if (resp.json && resp.json.signedJwt) return resp.json.signedJwt;
    warn("signer returned no jwt:", resp.statusCode, JSON.stringify(resp.json || {}).slice(0, 200));
  } catch (err) {
    warn("sidecar signer unavailable, falling back to openssl:", err.message || err);
  }

  // 2) openssl fallback: `openssl dgst -sha256 -sign key.pem -out sig data`
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = b64urlEncode(JSON.stringify(header)) + "." + b64urlEncode(JSON.stringify(claim));
  const tmp = $os.tempDir();
  const keyPath = tmp + "/gwmb_sa_" + $security.randomString(8) + ".pem";
  const inPath  = tmp + "/gwmb_in_" + $security.randomString(8);
  const outPath = tmp + "/gwmb_sig_" + $security.randomString(8);
  try {
    $os.writeFile(keyPath, privateKeyPem, 384);
    $os.writeFile(inPath, signingInput, 384);
    const cmd = $os.cmd("openssl", "dgst", "-sha256", "-sign", keyPath, "-out", outPath, inPath);
    cmd.run();
    const sig = $os.readFile(outPath);
    warn("jwt signed via openssl ok");
    return signingInput + "." + b64urlEncodeBinary(sig);
  } catch (err) {
    throw new Error("RS256 signing failed (no signer + no openssl): " + (err.message || err));
  } finally {
    try { $os.remove(keyPath); } catch (_) {}
    try { $os.remove(inPath); } catch (_) {}
    try { $os.remove(outPath); } catch (_) {}
  }
}

// Cached in the app store keyed by scope+subject (PB 0.39 has no rsaSign).
function getAccessToken(scopes, subject) {
  const scopeKey = scopes.join(" ");
  const cacheKey = "gwmb_token:" + scopeKey + "|" + (subject || "-");
  const store = $app.store();
  const cached = store.get(cacheKey);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.exp > nowSec + 120) return cached.token;

  const sa = loadServiceAccount();
  const claim = {
    iss: sa.client_email,
    scope: scopeKey,
    aud: "https://oauth2.googleapis.com/token",
    exp: nowSec + 3600,
    iat: nowSec
  };
  if (subject) claim.sub = subject;

  const jwt = signJwtRs256(claim, sa.private_key);
  const resp = $http.send({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + encodeURIComponent(jwt),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15
  });
  if (!resp.json || !resp.json.access_token) {
    throw new Error("GOOGLE_TOKEN_FAILED: " + JSON.stringify(resp.json || {}).slice(0, 300));
  }
  store.set(cacheKey, {
    token: resp.json.access_token,
    exp: nowSec + (resp.json.expires_in || 3600)
  });
  warn("oauth token ok for subject " + (subject || "-"));
  return resp.json.access_token;
}

class GoogleApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Low-level authenticated Google API call.
// opts: { url, method?, body?, scopes, subject?, timeout? }
function googleRequest(opts) {
  const token = getAccessToken(opts.scopes, opts.subject);
  const resp = $http.send({
    url: opts.url,
    method: opts.method || "GET",
    body: opts.body ? JSON.stringify(opts.body) : "",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    timeout: opts.timeout || 30
  });
  if (resp.statusCode >= 400) {
    let msg = "";
    try {
      msg = (resp.json && resp.json.error && (resp.json.error.message || resp.json.error.code)) || "";
    } catch (_) {}
    throw new GoogleApiError(resp.statusCode, "Google API " + resp.statusCode + ": " + msg);
  }
  return resp.json;
}

// ---------------------------------------------------------------------------
// Alerting (SLA breach monitor etc.)
// ---------------------------------------------------------------------------
function sendAlertWebhook(kind, payload) {
  const url = $os.getenv("MAILBOX_ALERT_WEBHOOK") || "";
  if (!url) return;
  try {
    $http.send({
      url: url,
      method: "POST",
      body: JSON.stringify(Object.assign({ kind: kind }, payload)),
      headers: { "Content-Type": "application/json" },
      timeout: 5
    });
  } catch (err) {
    warn("alert webhook failed:", err.message || err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // meta
  GMAIL_SCOPE, GMAIL_SEND_SCOPE, CAL_SCOPE, GMAIL_BASE, CAL_BASE, THREAD_STATUSES,
  log, warn,
  // http / auth
  addCorsHeaders, fail, actorFromEvent,
  // records
  safeFindById, safeFindFirstByFilter, inboxIdsForUser, canViewThreadForUser, requireThreadAccess,
  // dates
  nowDateTime, dateToPbString, isoToPbString, isSlaBreached,
  // notes / presence
  addInternalNote, heartbeatPresence, releasePresence, presenceSnapshot, composingLock,
  // google
  loadServiceAccount, getAccessToken, googleRequest, GoogleApiError,
  b64urlEncode, b64urlEncodeBinary, b64DecodeUtf8,
  // alerts
  sendAlertWebhook
};
