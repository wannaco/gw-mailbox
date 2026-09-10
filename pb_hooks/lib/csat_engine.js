// =============================================================================
// gw-mailbox — CSAT engine (module)
// Auto-dispatches a satisfaction survey when a thread is CLOSED: creates a
// csat_feedback row (unique token) and emails the customer a public link.
// The public page (no login) submits a 1–5 rating + optional comment, stored
// against the ticket/email. Agents see results in the thread drawer.
//
// Public (token = auth):
//   GET  /api/mailbox/csat/{token}    — validate + return survey state
//   POST /api/mailbox/csat/submit     — { token, rating, comment }
// Authed (agents):
//   GET  /api/mailbox/threads/{id}/csat — feedback rows for the thread drawer
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

// Absolute base used in the emailed survey link:
//   MAILBOX_PUBLIC_URL env -> app_settings.public_url -> PocketBase appURL
// Never hardcode a host: the same build is deployed to many domains, and a
// wrong base would email customers a link into someone else's instance.
// Returns "" when nothing usable is configured — callers skip sending.
function publicBase() {
  const env = $os.getenv("MAILBOX_PUBLIC_URL") || "";
  if (env) return String(env).replace(/\/+$/, "");
  try {
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    const v = rec ? String(rec.getString("public_url") || "").trim() : "";
    if (v && !/localhost|127\.0\.0\.1/.test(v)) return v.replace(/\/+$/, "");
  } catch (_) { /* missing */ }
  try {
    const st = $app.settings();
    const u = String((st && st.meta && st.meta.appURL) || "").trim();
    if (u && !/localhost|127\.0\.0\.1/.test(u)) return u.replace(/\/+$/, "");
  } catch (_) { /* missing */ }
  return "";
}

function randToken() {
  return "c" + $security.randomString(28) + String(Date.now()).slice(-6);
}

// CSAT must be opted in per install (Settings → CSAT). Off by default so no
// customer is ever emailed a survey unless a client enables it.
function csatEnabled() {
  try {
    const env = $os.getenv("MAILBOX_CSAT_ENABLED") || "";
    if (env === "1") return true;
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    if (!rec) return false;
    return rec.getBool("csat_enabled");
  } catch (_) { return false; }
}

function setCsatEnabled(enabled) {
  try {
    const coll = $app.findCollectionByNameOrId("app_settings");
    let rec = null;
    try { rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'"); } catch (_) { /* */ }
    if (!rec) rec = new Record(coll, { key: "instance" });
    rec.set("csat_enabled", !!enabled);
    $app.save(rec);
    return !!enabled;
  } catch (_) { return !!enabled; }
}

function findByToken(token) {
  try {
    return $app.findFirstRecordByFilter("csat_feedback", "token = {:t}", { t: String(token || "") });
  } catch (_) { return null; }
}

function view(r) {
  return {
    id: r.id,
    token: r.getString("token"),
    thread: r.getString("thread"),
    inbox: r.getString("inbox"),
    email: r.getString("email"),
    rating: r.getInt("rating") || null,
    comment: r.getString("comment") || "",
    sent_at: r.getString("sent_at"),
    responded_at: r.getString("responded_at"),
    url: publicBase() + "/csat/" + r.getString("token")
  };
}

// Send the customer a standalone "how did we do?" email with their survey
// link. Fresh message (no threadId) — a survey is its own conversation, not a
// reply inside the support thread. Reuses the engine's raw MIME builder.
function sendSurveyEmail(thread, uid, linkUrl) {
  const to = thread.getString("customer_email");
  const name = thread.getString("customer_name");
  const subject = "How did we do?";
  const body =
    "Hi " + (name || to) + ",\n\n" +
    "We just closed your ticket: \"" + (thread.getString("subject") || "(no subject)") + "\".\n\n" +
    "How was your experience with our support team? We'd love your feedback — it only takes a few seconds.\n\n" +
    linkUrl + "\n\n" +
    "Thanks,\n" + (uid || "the team");
  const ge = require(__hooks + "/lib/gmail_engine.js");
  return ge.sendFreshEmail(uid, to, name, subject, body);
}

// Dispatch a CSAT survey for a thread that just CLOSED. Idempotent-ish: if an
// UNRESPONDED survey already exists for this thread, skip (no duplicate spam);
// once responded (or re-closed later), a fresh one can go out. Fails softly —
// never break the close action.
function dispatchCsatOnClose(threadId) {
  try {
    // Feature gate: only dispatch when the client has enabled CSAT.
    if (!csatEnabled()) return null;
    const thread = h.safeFindById("threads", threadId);
    if (!thread) return null;
    const email = thread.getString("customer_email");
    if (!email) return null; // no customer to survey

    // Skip if there's already an open (unresponded) survey for this thread.
    try {
      const rows = $app.findRecordsByFilter("csat_feedback", "thread = {:t}", "-sent_at", 0, 0, { t: threadId }) || [];
      for (const r of rows) {
        try {
          const resp = r.getDateTime("responded_at");
          if (!resp || resp.isZero()) return r; // pending already
        } catch (_) { return r; }
      }
    } catch (_) { /* continue */ }

    const inbox = h.safeFindById("inboxes", thread.getString("inbox"));
    const uid = inbox ? inbox.getString("email_address") : "";
    if (!uid) return null;

    const coll = $app.findCollectionByNameOrId("csat_feedback");
    const token = randToken();
    const rec = new Record(coll, {
      token: token,
      thread: threadId,
      inbox: inbox.id,
      email: email,
      rating: null,
      comment: "",
      sent_at: new DateTime().string(),
      responded_at: ""
    });
    $app.save(rec);

    // Email (best-effort — if send fails, survey row still exists for manual use)
    try {
      const base = publicBase();
      if (!base) {
        h.warn("CSAT: no public URL configured (set MAILBOX_PUBLIC_URL) — survey not sent for", threadId);
        return null;
      }
      const url = base + "/csat/" + token;
      sendSurveyEmail(thread, uid, url);
      h.log("CSAT survey sent", threadId, "->", email);
    } catch (err) {
      h.warn("CSAT email failed for", threadId, (err && err.message) || err);
    }
    return rec;
  } catch (err) {
    h.warn("CSAT dispatch failed for", threadId, (err && err.message) || err);
    return null;
  }
}

// Public: validate a token and report whether it was already answered.
function handleCsatGet(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const token = e.request.pathValue("token") || "";
  const rec = findByToken(token);
  if (!rec) return h.fail(e, 404, "not_found", "Survey link not found");
  e.json(200, {
    ok: true,
    submitted: !!rec.getDateTime("responded_at") && !rec.getDateTime("responded_at").isZero(),
    token: rec.getString("token")
  });
}

// Public: submit a rating + comment for a token.
function handleCsatSubmit(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) { body = {}; }
  const rec = findByToken(body.token);
  if (!rec) return h.fail(e, 404, "not_found", "Survey link not found");
  const responded = rec.getDateTime("responded_at");
  if (responded && !responded.isZero()) {
    return h.fail(e, 409, "already_submitted", "This survey has already been answered");
  }
  const rating = parseInt(body.rating, 10);
  if (!rating || rating < 1 || rating > 5) return h.fail(e, 400, "bad_rating", "rating must be 1–5");
  rec.set("rating", rating);
  rec.set("comment", String(body.comment || "").slice(0, 5000));
  rec.set("responded_at", new DateTime().string());
  $app.save(rec);

  // Best-effort: note in the thread so agents see it surfaced live too.
  try {
    const thread = h.safeFindById("threads", rec.getString("thread"));
    if (thread) {
      h.addInternalNote(thread.id, { name: "CSAT", email: "system@mailbox.local" },
        "⭐ Customer rated " + rating + "/5" + (rec.getString("comment") ? " — \"" + rec.getString("comment") + "\"" : "") + ".");
    }
  } catch (_) { /* non-fatal */ }

  e.json(200, { ok: true, rating: rating });
}

// Authed: list CSAT rows for a thread (drawer display).
function handleThreadCsat(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const threadId = e.request.pathValue("id");
  if (actor.isSuperuser || h.canViewThreadForUser(h.safeFindById("threads", threadId), actor.recordId || actor.id)) {
    const rows = $app.findRecordsByFilter("csat_feedback", "thread = {:t}", "-sent_at", 0, 0, { t: threadId }) || [];
    return e.json(200, { ok: true, surveys: (rows || []).map(view) });
  }
  return h.fail(e, 403, "forbidden", "No access to this thread");
}

module.exports = {
  dispatchCsatOnClose,
  publicBase,
  csatEnabled,
  setCsatEnabled,
  handleCsatGet,
  handleCsatSubmit,
  handleThreadCsat,
  findByToken,
  view
};
