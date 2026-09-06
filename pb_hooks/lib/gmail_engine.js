// =============================================================================
// gw-mailbox — gmail ingestion engine (module)
// Handlers + engine live here so their closure scope survives PB 0.39's
// handler invocation context (see note in presence_api.js).
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

// ---------------------------------------------------------------------------
// base64 helpers (module scope has no atob/btoa — see helpers.b64DecodeUtf8)
// ---------------------------------------------------------------------------
function b64DecodeUtf8(s) {
  return h.b64DecodeUtf8(s);
}

// ---------------------------------------------------------------------------
// Header / message parsing (Gmail API "full" format)
// ---------------------------------------------------------------------------
function headerValue(headers, name) {
  for (const hdr of headers || []) {
    if (hdr.name && hdr.name.toLowerCase() === name.toLowerCase()) return hdr.value || "";
  }
  return "";
}

function parseAddress(raw) {
  raw = String(raw || "").trim();
  if (!raw) return { name: "", email: "" };
  const m = raw.match(/^([^<]*)\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: raw.toLowerCase() };
}

function collectAddresses(parts) {
  const out = [];
  for (const raw of String(parts || "").split(",")) {
    const a = parseAddress(raw);
    if (a.email) out.push(a.email);
  }
  return out;
}

function extractBodies(payload, acc) {
  acc = acc || { text: "", html: "" };
  if (!payload) return acc;
  const mime = (payload.mimeType || "").toLowerCase();
  const bodyData = payload.body && payload.body.data ? payload.body.data : "";

  if (mime === "text/plain" && bodyData) acc.text += b64DecodeUtf8(bodyData);
  else if (mime === "text/html" && bodyData) acc.html += b64DecodeUtf8(bodyData);

  for (const part of payload.parts || []) extractBodies(part, acc);
  return acc;
}

function normalizeMessage(msg, inboxEmail) {
  const headers = msg.payload && msg.payload.headers ? msg.payload.headers : [];
  const subject = headerValue(headers, "Subject");
  const from = parseAddress(headerValue(headers, "From"));
  const to = collectAddresses(headerValue(headers, "To") + "," + headerValue(headers, "Cc"));
  const bodies = extractBodies(msg.payload, null);
  const internalDate = parseInt(msg.internalDate || "0", 10);
  const iso = internalDate ? new Date(internalDate).toISOString() : "";

  let customer = null;
  if (from.email && from.email.toLowerCase() !== String(inboxEmail).toLowerCase()) {
    customer = from;
  } else {
    for (const addr of to) {
      if (addr.toLowerCase() !== String(inboxEmail).toLowerCase()) {
        customer = { name: "", email: addr };
        break;
      }
    }
  }

  return {
    gmail_message_id: msg.id,
    gmail_thread_id: msg.threadId,
    subject: subject || "(no subject)",
    snippet: msg.snippet || "",
    from: from,
    to: to,
    customer: customer,
    body_plain: bodies.text || "",
    body_html: bodies.html || "",
    received_iso: iso,
    epochMs: internalDate
  };
}

// ---------------------------------------------------------------------------
// Inbox helpers
// ---------------------------------------------------------------------------
function findInboxByEmail(email) {
  const want = String(email || "").toLowerCase();
  if (!want) return null;
  const rows = $app.findRecordsByFilter("inboxes", "is_active = true", "", 0, 0);
  for (const r of rows || []) {
    if (String(r.getString("email_address") || "").toLowerCase() === want) return r;
  }
  return null;
}

function requireInboxAccess(e, inboxId, actor) {
  const inbox = h.safeFindById("inboxes", inboxId);
  if (!inbox) { h.fail(e, 404, "inbox_not_found", "Inbox not found"); return null; }
  if (actor && actor.isSuperuser) return inbox;
  if (actor && h.inboxIdsForUser(actor.id).all.indexOf(inboxId) !== -1) return inbox;
  h.fail(e, 403, "forbidden", "No access to this inbox");
  return null;
}

function inboxUserEmail(inboxRec) {
  return inboxRec.getString("email_address");
}

// ---------------------------------------------------------------------------
// Storage (thread + message upserts)
// ---------------------------------------------------------------------------
function isoToPb(iso) {
  return h.isoToPbString(iso);
}

function upsertThreadAndMessage(inboxRec, norm) {
  const counters = { threadsCreated: 0, threadsUpdated: 0, messagesAdded: 0, skipped: 0 };
  const uid = inboxUserEmail(inboxRec);

  let thread = h.safeFindFirstByFilter("threads", "gmail_thread_id = {:g}", { g: norm.gmail_thread_id });
  const dateStr = norm.received_iso ? isoToPb(norm.received_iso) : "";

  if (!thread) {
    thread = new Record($app.findCollectionByNameOrId("threads"), {
      inbox: inboxRec.id,
      gmail_thread_id: norm.gmail_thread_id,
      subject: norm.subject,
      snippet: norm.snippet,
      customer_email: norm.customer ? norm.customer.email : "",
      customer_name: norm.customer ? norm.customer.name : "",
      status: "new",
      last_message_at: dateStr,
      tags: []
    });
    $app.save(thread);
    counters.threadsCreated++;
  } else {
    thread.set("subject", norm.subject || thread.getString("subject"));
    thread.set("snippet", norm.snippet || thread.getString("snippet"));
    if (norm.customer) {
      thread.set("customer_email", norm.customer.email);
      if (norm.customer.name) thread.set("customer_name", norm.customer.name);
    }
    const existingLast = thread.getDateTime("last_message_at");
    if (dateStr && (!existingLast || existingLast.isZero() || existingLast.before(new DateTime(dateStr)))) {
      thread.set("last_message_at", dateStr);
    }
    const isCustomerMail = norm.from.email && norm.from.email.toLowerCase() !== uid.toLowerCase();
    if (isCustomerMail && thread.getString("status") === "closed") {
      thread.set("status", "new"); // reopened by new customer activity
    }
    $app.save(thread);
    counters.threadsUpdated++;
  }

  const existingMsg = h.safeFindFirstByFilter("messages", "gmail_message_id = {:g}", { g: norm.gmail_message_id });
  if (existingMsg) {
    // Records created before msg_date existed may lack an accurate date —
    // refresh it from Gmail whenever we have a better value (no count bump:
    // the migration already counted existing rows).
    if (dateStr && existingMsg.getString("msg_date") !== dateStr) {
      try {
        existingMsg.set("msg_date", dateStr);
        $app.save(existingMsg);
      } catch (err) { /* non-fatal */ }
    }
    counters.skipped++;
    return counters;
  }
  const msg = new Record($app.findCollectionByNameOrId("messages"), {
    thread: thread.id,
    gmail_message_id: norm.gmail_message_id,
    sender_email: norm.from.email || "",
    recipient_emails: norm.to,
    body_html: norm.body_html,
    body_plain: norm.body_plain,
    msg_date: dateStr || "",
    is_internal_note: false
  });
  $app.save(msg);
  counters.messagesAdded++;
  bumpThreadMessageCount(thread, 1);
  return counters;
}

// Increments/decrements the thread's message_count (int field, never negative)
// so the UI can show per-thread counts + realtime unread state.
function bumpThreadMessageCount(threadRec, delta) {
  if (!threadRec) return;
  try {
    const cur = threadRec.getInt("message_count") || 0;
    threadRec.set("message_count", Math.max(0, cur + delta));
    $app.save(threadRec);
  } catch (err) {
    h.warn("message_count bump failed", threadRec.id, (err && err.message) || err);
  }
}

// ---------------------------------------------------------------------------
// Sync engines
// ---------------------------------------------------------------------------
function fetchFullMessage(uid, messageId) {
  return h.googleRequest({
    url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/messages/" + encodeURIComponent(messageId) + "?format=full",
    scopes: [h.GMAIL_SCOPE],
    subject: uid
  });
}

function syncFromHistory(inboxRec, startHistoryId, opts) {
  opts = opts || {};
  const uid = inboxUserEmail(inboxRec);
  const counters = { threadsCreated: 0, threadsUpdated: 0, messagesAdded: 0, skipped: 0, historyRead: 0 };
  let start = startHistoryId || inboxRec.getString("history_id") || "";
  let pageToken = "";
  let latestHistoryId = "";

  for (let page = 0; page < (opts.maxPages || 10); page++) {
    let url = h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/history" +
      "?historyTypes=messageAdded&labelId=INBOX&startHistoryId=" + encodeURIComponent(start);
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);

    const res = h.googleRequest({ url: url, scopes: [h.GMAIL_SCOPE], subject: uid });

    const history = res.history || [];
    counters.historyRead += history.length;
    for (const entry of history) {
      if (entry.id && (!latestHistoryId || entry.id > latestHistoryId)) latestHistoryId = String(entry.id);
      for (const added of entry.messagesAdded || []) {
        if (!added.message || !added.message.id) continue;
        try {
          const full = fetchFullMessage(uid, added.message.id);
          const norm = normalizeMessage(full, uid);
          const c = upsertThreadAndMessage(inboxRec, norm);
          counters.threadsCreated += c.threadsCreated;
          counters.threadsUpdated += c.threadsUpdated;
          counters.messagesAdded += c.messagesAdded;
          counters.skipped += c.skipped;
        } catch (err) {
          h.warn("message fetch failed", added.message.id, err.message || err);
        }
      }
    }

    pageToken = res.nextPageToken || "";
    if (!pageToken || !history.length) break;
  }

  const stored = inboxRec.getString("history_id") || "";
  if (latestHistoryId && (!stored || Number(latestHistoryId) > Number(stored))) {
    inboxRec.set("history_id", latestHistoryId);
    $app.save(inboxRec);
  }
  return counters;
}

function backfillInbox(inboxRec, opts) {
  opts = opts || {};
  const uid = inboxUserEmail(inboxRec);
  const counters = { threadsCreated: 0, threadsUpdated: 0, messagesAdded: 0, skipped: 0 };

  const listRes = h.googleRequest({
    url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/threads?q=in:inbox&maxResults=" + (opts.maxResults || 50),
    scopes: [h.GMAIL_SCOPE],
    subject: uid
  });

  for (const t of listRes.threads || []) {
    try {
      const threadRes = h.googleRequest({
        url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/threads/" + encodeURIComponent(t.id) + "?format=full",
        scopes: [h.GMAIL_SCOPE],
        subject: uid
      });
      for (const m of threadRes.messages || []) {
        const norm = normalizeMessage(m, uid);
        const c = upsertThreadAndMessage(inboxRec, norm);
        counters.threadsCreated += c.threadsCreated;
        counters.threadsUpdated += c.threadsUpdated;
        counters.messagesAdded += c.messagesAdded;
        counters.skipped += c.skipped;
      }
    } catch (err) {
      h.warn("thread fetch failed", t.id, err.message || err);
    }
  }
  return counters;
}

function syncInbox(inboxRec, opts) {
  opts = opts || {};
  const hasCursor = !!inboxRec.getString("history_id");
  if (!hasCursor || opts.backfill) {
    const res = backfillInbox(inboxRec, opts);
    // Persist a history cursor after backfill so subsequent polls use the
    // efficient incremental (history) path instead of re-listing everything.
    if (!inboxRec.getString("history_id")) {
      try {
        const uid = inboxUserEmail(inboxRec);
        const prof = h.googleRequest({
          url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/profile?fields=historyId",
          scopes: [h.GMAIL_SCOPE],
          subject: uid
        });
        if (prof && prof.historyId) {
          inboxRec.set("history_id", String(prof.historyId));
          $app.save(inboxRec);
        }
      } catch (err) {
        h.warn("could not store history cursor for", inboxUserEmail(inboxRec), err.message || err);
      }
    }
    return res;
  }
  return syncFromHistory(inboxRec, opts.startHistoryId || "", opts);
}

function startWatch(inboxRec) {
  const uid = inboxUserEmail(inboxRec);
  const topic = $os.getenv("GOOGLE_PUBSUB_TOPIC") || "";
  if (!topic) throw new Error("GOOGLE_PUBSUB_TOPIC is not configured (projects/{project}/topics/{topic})");

  const res = h.googleRequest({
    url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/watch",
    method: "POST",
    body: { labelIds: ["INBOX"], topicName: topic, labelFilterBehavior: "INCLUDE" },
    scopes: [h.GMAIL_SCOPE],
    subject: uid
  });
  if (res.historyId && !inboxRec.getString("history_id")) {
    inboxRec.set("history_id", String(res.historyId));
    $app.save(inboxRec);
  }
  return res;
}

function stopWatch(inboxRec) {
  const uid = inboxUserEmail(inboxRec);
  return h.googleRequest({
    url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/stop",
    method: "POST",
    body: {},
    scopes: [h.GMAIL_SCOPE],
    subject: uid
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
function webhookAuthorized(e) {
  const secret = $os.getenv("MAILBOX_WEBHOOK_SECRET") || "";
  if (!secret) return true; // dev mode — protect via network / Pub/Sub OIDC
  const token = e.request.header("X-Mailbox-Webhook-Token") || "";
  if (!token || token !== secret) return false;
  return true;
}

function handleWebhookProbe(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  e.json(200, { ok: true, service: "gw-mailbox-gmail-webhook" });
}

function handleWebhookPush(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  if (!webhookAuthorized(e)) return h.fail(e, 401, "unauthorized", "Bad webhook token");

  let push;
  try {
    push = JSON.parse(toString(e.request.body));
  } catch (_) {
    return h.fail(e, 400, "bad_request", "Invalid JSON body");
  }

  // Always ack Google promptly (200), even if we cannot process it.
  try {
    const data = push.message ? b64DecodeUtf8(push.message.data || "") : "";
    const attrs = push.message && push.message.attributes ? push.message.attributes : {};
    h.log("webhook push received:", attrs.emailAddress, "historyId:", attrs.historyId);

    const inbox = findInboxByEmail(attrs.emailAddress);
    if (!inbox) {
      h.warn("no active inbox for", attrs.emailAddress, "- skipped");
      return e.json(200, { ok: true, skipped: "no_inbox" });
    }

    const counters = syncInbox(inbox, { startHistoryId: attrs.historyId });
    h.log("webhook sync done for", attrs.emailAddress, JSON.stringify(counters));
    e.json(200, { ok: true, counters: counters });
  } catch (err) {
    h.warn("webhook processing error:", err.message || err);
    // Acknowledged anyway — the history cursor guarantees replay safety.
    e.json(200, { ok: true, processingError: (err.message || String(err)).slice(0, 300) });
  }
}

function handleWatch(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const inbox = requireInboxAccess(e, e.request.pathValue("id"), actor);
  if (!inbox) return;
  try {
    const res = startWatch(inbox);
    e.json(200, { ok: true, historyId: res.historyId, expiration: res.expiration || null });
  } catch (err) {
    h.fail(e, 502, "watch_failed", err.message || String(err));
  }
}

function handleSync(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const inbox = requireInboxAccess(e, e.request.pathValue("id"), actor);
  if (!inbox) return;

  const q = e.request.url.query();
  const backfill = (q.get("backfill") || "") === "1";
  try {
    const counters = syncInbox(inbox, { backfill: backfill, maxResults: 100 });
    e.json(200, Object.assign({ ok: true }, counters));
  } catch (err) {
    h.fail(e, 502, "sync_failed", err.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// POST /api/mailbox/threads/{id}/reply — send an email reply on the inbox
// ---------------------------------------------------------------------------
function sanitizeHeaderValue(s) {
  return String(s || "").replace(/[\r\n]/g, " ").trim();
}

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++; // surrogate pair consumed
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function chunkB64(b64) {
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join("\r\n");
}

function buildReplyRaw(uid, thread, text, htmlBody, attachments) {
  attachments = attachments || [];
  const to = thread.getString("customer_email");
  const name = thread.getString("customer_name");
  let subject = thread.getString("subject") || "(no subject)";
  if (!/^re:\s*/i.test(subject)) subject = "Re: " + subject;
  subject = sanitizeHeaderValue(subject);

  const plain = String(text || "").trim();
  const hasHtml = !!(htmlBody && String(htmlBody).trim());
  const html = hasHtml
    ? String(htmlBody).trim()
    : "<html><body>" + plain.split(/\n+/).map((p) => "<p>" + escHtml(p) + "</p>").join("") + "</body></html>";

  const bMixed = "gwmb_m_" + $security.randomString(12);
  const bAlt = "gwmb_a_" + $security.randomString(12);
  let raw =
    "To: " + (name ? sanitizeHeaderValue(name) + " <" + to + ">" : to) + "\r\n" +
    "From: " + sanitizeHeaderValue(uid) + "\r\n" +
    "Subject: " + subject + "\r\n" +
    "MIME-Version: 1.0\r\n";

  const altPart =
    "Content-Type: multipart/alternative; boundary=\"" + bAlt + "\"\r\n\r\n" +
    "--" + bAlt + "\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n\r\n" + plain + "\r\n\r\n" +
    "--" + bAlt + "\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n\r\n" + html + "\r\n\r\n" +
    "--" + bAlt + "--\r\n";

  if (attachments.length) {
    raw += "Content-Type: multipart/mixed; boundary=\"" + bMixed + "\"\r\n\r\n" +
      "--" + bMixed + "\r\n" + altPart;
    for (const att of attachments) {
      const attName = h.mimeHeaderValue(att.name);
      const mime = h.mimeHeaderValue(att.mime) || "application/octet-stream";
      raw += "--" + bMixed + "\r\n" +
        "Content-Type: " + mime + "; name=\"" + attName + "\"\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "Content-Disposition: attachment; filename=\"" + attName + "\"\r\n\r\n" +
        chunkB64(att.b64) + "\r\n";
    }
    raw += "--" + bMixed + "--\r\n";
  } else {
    // altPart already starts with its own Content-Type header line.
    raw += altPart;
  }
  return h.b64urlEncodeBinary(utf8Bytes(raw));
}

function handleReply(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;
  const thread = access.thread;

  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) {}

  const htmlBody = (body.html || "").toString();
  const text = (body.body || body.text || h.htmlToPlain(htmlBody) || "").toString().trim();
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  if (!text && !hasAttachments && !htmlBody.trim()) {
    return h.fail(e, 400, "empty_reply", "Reply body is required");
  }

  const inbox = h.safeFindById("inboxes", thread.getString("inbox"));
  const uid = inbox ? inbox.getString("email_address") : "";
  if (!uid) return h.fail(e, 400, "inbox_missing", "Thread inbox has no email_address");
  if (!thread.getString("customer_email")) {
    return h.fail(e, 400, "no_customer", "Thread has no customer_email to reply to");
  }

  // Sanitize rich HTML server-side; decode attachments to base64 payloads.
  const safeHtml = htmlBody.trim() ? h.sanitizeHtmlBasic(htmlBody) : "";
  const atts = [];
  if (hasAttachments) {
    let total = 0;
    for (const att of body.attachments) {
      const nm = String(att.name || "attachment").replace(/[^\w.\- ]+/g, "_");
      const dataStr = String(att.data || "");
      const comma = dataStr.indexOf(",");
      const b64 = comma >= 0 ? dataStr.slice(comma + 1) : dataStr;
      total += Math.ceil((b64.length * 3) / 4);
      if (total > 25 * 1024 * 1024) {
        return h.fail(e, 400, "attachments_too_large", "Total attachment size exceeds 25MB");
      }
      atts.push({ name: nm, mime: String(att.mime || "application/octet-stream"), b64: b64, bytes: h.b64ToBytes(b64) });
    }
  }

  try {
    const raw = buildReplyRaw(uid, thread, text || h.htmlToPlain(safeHtml), safeHtml, atts);
    const sent = h.googleRequest({
      url: h.GMAIL_BASE + "/users/" + encodeURIComponent(uid) + "/messages/send",
      method: "POST",
      body: { raw: raw, threadId: thread.getString("gmail_thread_id") },
      scopes: [h.GMAIL_SCOPE, h.GMAIL_SEND_SCOPE],
      subject: uid
    });

    // Persist the sent message (with attachments) into the conversation.
    const msgColl = $app.findCollectionByNameOrId("messages");
    const msg = new Record(msgColl, {
      thread: thread.id,
      gmail_message_id: sent.id || "",
      sender_email: uid,
      recipient_emails: [thread.getString("customer_email")],
      body_html: safeHtml || "",
      body_plain: text || h.htmlToPlain(safeHtml),
      msg_date: h.dateToPbString(new Date()),
      is_internal_note: false
    });
    if (atts.length) {
      const files = [];
      const meta = [];
      for (const a of atts) {
        files.push($filesystem.fileFromBytes(a.bytes, a.name));
        meta.push({ name: a.name, mime: a.mime, size: a.bytes.length });
      }
      msg.set("attachments", files);
      msg.set("attachments_meta", meta);
    }
    $app.save(msg);
    bumpThreadMessageCount(thread, 1);

    e.json(200, { ok: true, gmail_message_id: sent.id || "", threadId: thread.id, messageId: msg.id });
  } catch (err) {
    h.warn("send failed for", thread.id, "->", (err && err.message) || String(err));
    // 200-with-error: proxy rewrites 5xx -> useless "error code: 502".
    e.json(200, { ok: false, error: "send_failed", message: (err && err.message) || String(err) });
  }
}

module.exports = {
  handleWebhookProbe,
  handleWebhookPush,
  handleWatch,
  handleSync,
  handleReply,
  // exposed for tests / future cron replay
  syncInbox,
  findInboxByEmail
};
