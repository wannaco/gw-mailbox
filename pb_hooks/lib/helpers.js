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
const CAL_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"; // freeBusy needs the read scope
const GMAIL_BASE   = "https://gmail.googleapis.com/gmail/v1";
const CAL_BASE     = "https://www.googleapis.com/calendar/v3";

const THREAD_STATUSES = ["new", "in_progress", "waiting_customer", "escalated", "closed", "spam", "archived"];

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
    // Superuser = observe/admin role: carry the REAL _superusers record email
    // so notes/replies/audit rows pass PB's email validation ("admin@local"
    // does not). Fall back to a valid synthetic address only if no record is
    // reachable on the event.
    const su = e.auth;
    const name = (su && (su.getString("name") || "")) || "Admin";
    const email = (su && su.getString("email")) || "admin@mailbox.local";
    // Break-glass ops token (dashboard/CLI): counts as admin for the app's
    // routes so scripts keep working, but id !== a users record.
    return { id: "superuser", recordId: su ? su.id : "", name: name, email: email, isSuperuser: true, isAdmin: true, role: "admin" };
  }
  if (e.auth) {
    // App user. `role` is the APPLICATION role (users.role: agent|admin) — the
    // browser never authenticates against _superusers. isSuperuser stays true
    // only for the PB break-glass token (dashboard/CLI/ops scripts) so those
    // paths keep working; app code must gate on isAdmin.
    let role = "";
    try { role = String(e.auth.getString("role") || ""); } catch (_) { role = ""; }
    return {
      id: e.auth.id,
      name: e.auth.getString("name") || e.auth.getString("email"),
      email: e.auth.getString("email"),
      googleEmail: e.auth.getString("googleEmail") || "",
      role: role,
      isAdmin: role === "admin",
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
  if (actor.isAdmin) return { thread };   // app admins see every thread
  if (!canViewThreadForUser(thread, actor.id)) { fail(e, 403, "forbidden", "No access to this thread"); return null; }
  return { thread };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function nowDateTime() { return new DateTime(); }

// Reporting stamp: when a thread transitioned INTO closed, record closed_at.
// Re-open + re-close refreshes it (resolution time = last close).
function markThreadClosed(threadRec) {
  try {
    if (!threadRec) return;
    if (threadRec.getString("status") !== "closed") return;
    threadRec.set("closed_at", new DateTime().string());
    $app.save(threadRec);
  } catch (_) { /* non-fatal */ }
}

// PB date-layout string (e.g. "2026-09-05 15:13:19.123Z") — always parseable
// by PB filters and date fields.
function dateToPbString(d) {
  try { return d.string(); } catch (_) { return ""; }
}

function isoToPbString(iso) {
  try { return new DateTime(iso).string(); } catch (_) { return new DateTime().string(); }
}

// Give a thread its first-response deadline when a human moves it INTO an
// active state (new / in_progress) and it has none.
//
// Why this is needed: imported history and archived threads deliberately carry
// NO deadline (they are archive, not queue). Picking one up to actually work it
// changed the status but started no clock, so the ticket sat in an active column
// with no SLA at all.
//
// Anchoring: the customer's message, so the deadline still means "respond N
// hours after they wrote" — but never a deadline that has already passed, since
// a thread you just started working must not appear instantly breached. A clock
// that already exists is left untouched, so toggling status can never be used to
// reset a deadline and dodge it.
function ensureSlaDeadline(threadRec) {
  try {
    if (!threadRec) return false;
    const cur = threadRec.getDateTime("sla_due_at");
    if (cur && !cur.isZero()) return false; // already ticking — leave it alone
    const hours = effectiveSlaHours() || 24;
    const now = new DateTime();
    let due = now.add(hours * 3600 * 1e9);
    const last = threadRec.getDateTime("last_message_at");
    if (last && !last.isZero()) {
      const fromLast = last.add(hours * 3600 * 1e9);
      if (fromLast.after(now)) due = fromLast; // still inside the customer's window
    }
    threadRec.set("sla_due_at", due.string());
    return true;
  } catch (_) {
    return false;
  }
}

// Statuses where the SLA clock should be running.
var SLA_ACTIVE_STATUSES = ["new", "in_progress"];

// Clear a thread's first-response deadline so the next ensureSlaDeadline()
// computes a FRESH one.
//
// Needed when a thread is rescued OUT of spam. Marking spam leaves sla_due_at
// untouched, so a thread that sat in spam for a day still carries its old, now
// past deadline. Un-spamming it without clearing that would leave it reading as
// instantly overdue and the hourly monitor would escalate it straight back out
// of the queue — the rescue would look like it failed.
//
// Same principle as imported history: never let a clock that is already in the
// past decide an active ticket's fate.
function resetSlaDeadline(threadRec) {
  try {
    if (!threadRec) return;
    threadRec.set("sla_due_at", "");
  } catch (_) { /* non-fatal */ }
}

// true when thread.sla_due_at <= now (breached)
function isSlaBreached(threadRec) {
  const due = threadRec.getDateTime("sla_due_at");
  if (!due || due.isZero()) return false;
  return due.before(new DateTime());
}

// ---------------------------------------------------------------------------
// SLA config (app_settings singleton) — SLA visibility + breach escalation.
// Fields added by migration 1786000016_sla.js. Defaults keep the historical
// behavior: enabled, first response due 24h after the ticket arrives.
// ---------------------------------------------------------------------------
function readSlaConfig() {
  const out = { sla_enabled: true, sla_hours: 24 };
  try {
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    if (!rec) return out;
    try { out.sla_enabled = rec.getBool("sla_enabled"); } catch (_) { /* missing field */ }
    try {
      const v = rec.get("sla_hours");
      const n = (v === undefined || v === null || v === "") ? out.sla_hours : Number(v);
      if (!isNaN(n) && n > 0) out.sla_hours = n;
    } catch (_) { /* missing field */ }
  } catch (_) { /* row may not exist yet */ }
  return out;
}

function saveSlaConfig(cfg) {
  cfg = cfg || {};
  const cur = readSlaConfig();
  const hours = Number(cfg.sla_hours);
  const enabled = cfg.sla_enabled !== undefined ? !!cfg.sla_enabled : cur.sla_enabled;
  const coll = $app.findCollectionByNameOrId("app_settings");
  let rec = null;
  try { rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'"); } catch (_) { /* */ }
  if (!rec) rec = new Record(coll, { key: "instance" });
  rec.set("sla_enabled", enabled);
  rec.set("sla_hours", !isNaN(hours) && hours > 0 ? hours : cur.sla_hours);
  $app.save(rec);
  return readSlaConfig();
}

// Convenience used by the thread-create hook: SLA hours from settings, falling
// back to the MAILBOX_SLA_HOURS env and then the 24h default.
function effectiveSlaHours() {
  try { return readSlaConfig().sla_hours; } catch (_) { /* */ }
  const env = parseInt($os.getenv("MAILBOX_SLA_HOURS") || "24", 10);
  return !isNaN(env) && env > 0 ? env : 24;
}

// ---------------------------------------------------------------------------
// Internal notes (messages with is_internal_note=true, no gmail id)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Adds an internal note to a thread and bumps thread.updated so the SSE
// stream wakes all open viewers. Does NOT touch last_message_at (that field
// tracks real customer email traffic). Accepts rich HTML via meta.html (the
// note body is sanitized server-side by the caller) — legacy plain-text notes
// keep the old escaped single-paragraph markup.
function addInternalNote(threadId, actor, bodyText, meta) {
  meta = meta || {};
  const thread = safeFindById("threads", threadId);
  if (!thread) return null;
  const coll = $app.findCollectionByNameOrId("messages");
  const richHtml = String(meta.html || "").trim();
  const html = richHtml
    ? richHtml
    : "<p><strong>Internal note</strong></p><p>" + escapeHtml(bodyText) + "</p>";
  const note = new Record(coll, {
    thread: threadId,
    sender_email: actor ? (actor.email || "system@mailbox.local") : "system@mailbox.local",
    recipient_emails: [],
    body_html: html,
    body_plain: bodyText || "",
    msg_date: new DateTime().string(),
    is_internal_note: true
  });
  $app.save(note);

  // Bump the thread's note counter. This is the single place every internal note
  // is created, so it is the only place that needs to maintain notes_count — the
  // UI uses it to show an unread-notes badge without loading messages.
  try {
    thread.set("notes_count", (thread.getInt("notes_count") || 0) + 1);
    $app.save(thread);
  } catch (err) {
    warn("could not bump notes_count for", threadId, (err && err.message) || err);
  }

  log("internal note added", threadId, "by", actor ? actor.name : "system");

  // Notify @mentioned teammates + the thread's assignee (skip author).
  try {
    require(__hooks + "/lib/notifications_engine.js").notifyNoteMentions(thread, note, actor, bodyText || "");
  } catch (err) {
    warn("notification dispatch failed", (err && err.message) || err);
  }
  return note;
}

// ---------------------------------------------------------------------------
// Presence engine (collision prevention + draft locks)
// ---------------------------------------------------------------------------
// NOTE: DateTime.sub() returns a Go time.Duration = NANOSECONDS.
const PRESENCE_MAX_AGE_NS = 10 * 60 * 1e9;   // hard cap; cron sweeps at 2 min
const PRESENCE_THROTTLE_NS = 4e9;            // don't re-broadcast identical heartbeats

// A session that dies without releasing (tab closed, laptop shut, network drop)
// leaves its row behind. Judging freshness by the 10-minute sweep cap meant
// "X is drafting a reply" — and a locked composer — persisted for up to ten
// minutes after X had gone. Locks and the presence list use this instead.
//
// 90s is chosen against the 6s heartbeat: browsers throttle timers in hidden
// tabs to about one beat per minute, so a genuinely-open background tab stays
// fresh, while a dead one drops out within a beat and a half.
const PRESENCE_FRESH_NS = 90 * 1e9;

function presenceCollection() {
  return $app.findCollectionByNameOrId("thread_presence");
}

// Newest-first, and self-healing: if more than one row exists for the pair
// (created before the unique index in 1786000029, or by a race the index can't
// cover) keep the newest and delete the rest. Without the sort this returned
// an arbitrary row, so a stale one could be updated forever while the live one
// sat untouched.
function findPresence(threadId, userId) {
  let rows = [];
  try {
    rows = $app.findRecordsByFilter(
      "thread_presence",
      "thread = {:t} && user = {:u}",
      "-updated_at",
      0,
      0,
      { t: threadId, u: userId }
    ) || [];
  } catch (_) {
    return null;
  }
  if (!rows.length) return null;
  for (let i = 1; i < rows.length; i++) {
    try { $app.delete(rows[i]); } catch (_) { /* best effort */ }
  }
  return rows[0];
}

// Latest row per user for a thread. Used wherever presence is read, so a
// leftover duplicate can't win over the live heartbeat.
function presenceRowsForThread(threadId) {
  const rows = $app.findRecordsByFilter("thread_presence", "thread = {:t}", "-updated_at", 0, 0, { t: threadId }) || [];
  const byUser = {};
  for (const r of rows) {
    const u = r.getString("user");
    if (byUser[u]) { try { $app.delete(r); } catch (_) {} continue; } // older dup
    byUser[u] = r;
  }
  return Object.keys(byUser).map(function (k) { return byUser[k]; });
}

// Who else (not `userId`) is composing on this thread right now?
function composingLock(threadId, excludeUserId) {
  const rows = presenceRowsForThread(threadId).filter(function (r) {
    return r.getString("status") === "composing_reply" && r.getString("user") !== (excludeUserId || "");
  });
  for (const row of rows || []) {
    const fresh = nowDateTime().sub(row.getDateTime("updated_at")) < PRESENCE_FRESH_NS;
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
    try {
      row = new Record(coll, { thread: threadId, user: userId, status: status, updated_at: now });
      $app.save(row);
      return { ok: true, changed: true, lock: composingLock(threadId, userId) };
    } catch (err) {
      // Lost a race against a concurrent heartbeat for the same pair: the
      // unique index rejected this insert, so re-read and update that row.
      row = findPresence(threadId, userId);
      if (!row) throw err;
    }
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
  const rows = presenceRowsForThread(threadId);
  const out = [];
  for (const row of rows || []) {
    if (nowDateTime().sub(row.getDateTime("updated_at")) > PRESENCE_FRESH_NS) continue;
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

// Decode RFC 2047 encoded-words in a header value (e.g. Gmail subjects/names):
//   =?UTF-8?B?....?=   base64 body
//   =?UTF-8?Q?....?=   quoted-printable body (_ = space, =XX = byte)
// Literal UTF-8 and ASCII pass through untouched. Unknown/garbled -> best-effort.
function decodeHeaderWords(s) {
  s = String(s || "");
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let m, out = "", last = 0;
  while ((m = re.exec(s)) !== null) {
    // RFC 2047: whitespace-only gaps between adjacent encoded-words are
    // ignored (needed for chunked words and to match Gmail's own decode).
    const gap = s.slice(last, m.index);
    if (gap && /[^\s]/.test(gap)) out += gap;
    const enc = m[2].toUpperCase();
    let piece = m[3];
    try {
      if (enc === "B") {
        piece = b64DecodeUtf8(m[3]);
      } else {
        // Q: underscores are spaces; =XX / %XX are UTF-8 bytes.
        const q = String(m[3]).replace(/_/g, " ");
        const bytes = [];
        let i = 0;
        while (i < q.length) {
          if ((q[i] === "=" || q[i] === "%") && i + 2 < q.length && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
            bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
            i += 3;
          } else {
            const cp = q.codePointAt(i);
            bytes.push(cp < 0x80 ? cp : 0x3f);
            i += (cp > 0xffff) ? 2 : 1;
          }
        }
        const u8 = new Uint8Array(bytes);
        let t = "";
        for (let j = 0; j < u8.length; ) {
          const b = u8[j];
          if (b < 0x80) { t += String.fromCharCode(b); j++; }
          else if ((b >> 5) === 0x6 && j + 1 < u8.length) { t += String.fromCharCode(((b & 0x1f) << 6) | (u8[j + 1] & 0x3f)); j += 2; }
          else if ((b >> 4) === 0xe && j + 2 < u8.length) { t += String.fromCharCode(((b & 0x0f) << 12) | ((u8[j + 1] & 0x3f) << 6) | (u8[j + 2] & 0x3f)); j += 3; }
          else if ((b >> 3) === 0x1e && j + 3 < u8.length) { const cp = ((b & 0x07) << 18) | ((u8[j + 1] & 0x3f) << 12) | ((u8[j + 2] & 0x3f) << 6) | (u8[j + 3] & 0x3f); t += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)); j += 4; }
          else { t += String.fromCharCode(b); j++; }
        }
        piece = t;
      }
    } catch (_) { piece = m[3]; }
    out += piece;
    last = re.lastIndex;
  }
  return out + s.slice(last);
}

// Encode a header value for OUTBOUND raw MIME (RFC 2047). Pure ASCII passes
// through untouched; runs containing non-ASCII become =?UTF-8?Q?...?= words so
// recipient clients never mis-decode 8-bit headers as Latin-1 (the exact way
// subjects like "café" got mojibake'd into "cafÃƒÂ©" on the wire).
function encodeHeaderWords(s) {
  s = String(s == null ? "" : s);
  // Pure ASCII (and empty) passes through untouched.
  let hasHi = false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) { hasHi = true; break; }
  if (!hasHi) return s;
  // Whole-value RFC 2047 Q-encoding: raw 8-bit header bytes get mis-decoded as
  // Latin-1 by many mail clients (caf\u00e9 -> caf\u00c3\u00a9 mojibake), so any
  // non-ASCII subject/name must travel as =?UTF-8?Q?...?= words. Encode each
  // CODE POINT's bytes as one unit and group whole units into encoded-words
  // (max ~55 q-chars) joined by CRLF+space; RFC 2047 concatenates adjacent
  // words without inserting spaces, and never splitting a multi-byte char
  // across words keeps every decoder faithful.
  const qChar = (cp) => {
    let bytes = [];
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    let q = "";
    for (let j = 0; j < bytes.length; j++) {
      const b = bytes[j];
      if (b === 0x20) q += "_";
      else if (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) q += String.fromCharCode(b);
      else q += "=" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
    }
    return q;
  };
  const units = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    units.push(qChar(cp));
  }
  const words = [];
  let cur = "";
  for (let k = 0; k < units.length; k++) {
    if (cur && cur.length + units[k].length > 55) { words.push("=?UTF-8?Q?" + cur + "?="); cur = ""; }
    cur += units[k];
  }
  if (cur) words.push("=?UTF-8?Q?" + cur + "?=");
  return words.join("\r\n ");
}

// Conservative detector for Latin-1/cp1252 mojibake (UTF-8 bytes mis-decoded as
// cp1252 then stored/re-encoded) — e.g. "cafÃƒÂ©", "Ã¢Â˜Â•". Used to stop a
// corrupted subject from a re-synced Gmail message clobbering a clean one.
const MOJI_BAD = /(=\?[^?]+\?[bBqQ]\?[^?]*\?=|=\?[^?]+\?[bBqQ]\?|=\?[^?]+\?=|Ã[\x80-\xFF]|Â[\x80-\xFF]|â€[™“”•˜–—’‘]|Ã¢|Ãƒ|Ã©|Ã¨|Ã¬|Ã²|Ã¹|Ã¡|Ã­|Ã³|Ãº|Ã±|Ã¼|Ã¶|Ã¤|Ã¯|Ã«|Ã§|\uFFFD)/;
function looksMojibake(s) {
  return typeof s === "string" && MOJI_BAD.test(s);
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
// Decode (standard or URL-safe) base64 into raw bytes (Uint8Array) — no atob.
function b64ToBytes(b64) {
  let s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  let out = [];
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
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ASCII-safe header value (strip CR/LF/control chars).
function mimeHeaderValue(v) {
  return String(v || "").replace(/[\r\n]/g, " ").replace(/[^\x20-\x7E]/g, "").trim();
}

// Minimal HTML -> plain text (for the plain part + storage).
function htmlToPlain(html) {
  let s = String(html || "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// Server-side HTML sanitizer (remove scripts/styles/events/iframes etc.).
function sanitizeHtmlBasic(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<(iframe|object|embed|link|meta|form|input|button)[^>]*>/gi, "");
  s = s.replace(/<\/(iframe|object|embed|link|meta|form|input|button)>/gi, "");
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src)\s*=\s*(?:"|')?\s*javascript:/gi, '$1="#"');
  return s;
}

module.exports = {
  // meta
  GMAIL_SCOPE, GMAIL_SEND_SCOPE, CAL_SCOPE, CAL_READ_SCOPE, GMAIL_BASE, CAL_BASE, THREAD_STATUSES,
  log, warn,
  // http / auth
  addCorsHeaders, fail, actorFromEvent,
  // records
  safeFindById, safeFindFirstByFilter, inboxIdsForUser, canViewThreadForUser, requireThreadAccess,
  // dates
  nowDateTime, dateToPbString, isoToPbString, isSlaBreached,
  readSlaConfig, saveSlaConfig, effectiveSlaHours, markThreadClosed,
  ensureSlaDeadline, resetSlaDeadline, SLA_ACTIVE_STATUSES,
  // notes / presence
  addInternalNote, heartbeatPresence, releasePresence, presenceSnapshot, composingLock,
  // google
  loadServiceAccount, getAccessToken, googleRequest, GoogleApiError,
  b64urlEncode, b64urlEncodeBinary, b64EncodeBytes, b64DecodeUtf8, b64ToBytes, decodeHeaderWords, encodeHeaderWords, looksMojibake,
  mimeHeaderValue, htmlToPlain, sanitizeHtmlBasic,
  // alerts
  sendAlertWebhook
};
