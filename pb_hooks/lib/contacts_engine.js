// =============================================================================
// gw-mailbox — contacts engine
// Auto-upsert a contact from an inbound sender; lookup by email for the UI.
// Routes (registered in main.pb.js):
//   GET  /api/mailbox/contacts?email=...        — find one (or list by q)
//   POST /api/mailbox/contacts/save             — create/update a contact
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

function readBody(e) {
  try { return JSON.parse(toString(e.request.body) || "{}"); } catch (_) { return {}; }
}

function findByEmail(email) {
  if (!email) return null;
  try {
    return $app.findFirstRecordByFilter("contacts", "email = {:e}", { e: String(email).toLowerCase() });
  } catch (_) { return null; }
}

// Auto-create/refresh from inbound message sender.
function upsertFromSender(email, name, lastSeenIso) {
  if (!email) return null;
  try {
    const em = String(email).toLowerCase();
    let rec = findByEmail(em);
    const coll = $app.findCollectionByNameOrId("contacts");
    if (!rec) {
      rec = new Record(coll, { email: em, name: name || "", tags: [] });
      $app.save(rec);
    } else {
      // Refresh name if we learned a better one
      if (name && !rec.getString("name")) {
        rec.set("name", name);
        $app.save(rec);
      }
    }
    if (lastSeenIso) {
      try {
        const last = rec.getDateTime("last_seen");
        const incoming = new DateTime(lastSeenIso);
        if (!last || last.isZero() || last.before(incoming)) {
          rec.set("last_seen", incoming.string());
          $app.save(rec);
        }
      } catch (_) { /* ignore */ }
    }
    return rec;
  } catch (err) {
    h.warn("contact upsert failed", email, (err && err.message) || err);
    return null;
  }
}

function contactView(r) {
  return {
    id: r.id,
    email: r.getString("email"),
    name: r.getString("name"),
    phone: r.getString("phone"),
    company: r.getString("company"),
    title: r.getString("title"),
    notes: r.getString("notes"),
    tags: r.get("tags") || [],
    last_seen: r.getString("last_seen")
  };
}

// Route handlers -------------------------------------------------------------
function handleGetContacts(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const q = e.request.url.query();
  const email = (q.get("email") || "").toString().toLowerCase();
  if (email) {
    const rec = findByEmail(email);
    const related = (q.get("related") || "") === "1";
    const inbox = (q.get("inbox") || "").toString() || undefined;
    const out = { ok: true, contact: rec ? contactView(rec) : null };
    if (related && rec) {
      out.threads = threadsForContact(rec.getString("email"), inbox);
    }
    return e.json(200, out);
  }
  const search = (q.get("q") || "").toString();
  let rows = $app.findRecordsByFilter("contacts", "", "email", 0, 0) || [];
  if (search) {
    rows = (rows || []).filter((r) => {
      const hay = (r.getString("email") + " " + r.getString("name") + " " + r.getString("company")).toLowerCase();
      return hay.indexOf(search.toLowerCase()) !== -1;
    });
  }
  e.json(200, { ok: true, contacts: (rows || []).map(contactView) });
}

// Related cases: threads from this contact (optionally within one inbox).
function threadsForContact(email, inboxId) {
  try {
    const want = String(email || "").toLowerCase();
    const rows = $app.findRecordsByFilter("threads", "", "-last_message_at", 0, 100) || [];
    return (rows || []).filter((t) => {
      if (String(t.getString("customer_email") || "").toLowerCase() !== want) return false;
      if (inboxId && t.getString("inbox") !== inboxId) return false;
      return true;
    }).map((t) => ({
      id: t.id,
      subject: t.getString("subject"),
      status: t.getString("status"),
      last_message_at: t.getString("last_message_at"),
      inbox: t.getString("inbox"),
      message_count: t.getInt("message_count") || 0
    }));
  } catch (err) {
    h.warn("related threads failed", (err && err.message) || err);
    return [];
  }
}

function handleSaveContact(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");
  const body = readBody(e);
  const email = String(body.email || "").toLowerCase().trim();
  if (!email || email.indexOf("@") === -1) return h.fail(e, 400, "invalid_email", "A valid email is required");

  let rec = findByEmail(email);
  const coll = $app.findCollectionByNameOrId("contacts");
  if (!rec) {
    rec = new Record(coll, { email: email, tags: [] });
  }
  if (body.name !== undefined) rec.set("name", String(body.name || "").slice(0, 200));
  if (body.phone !== undefined) rec.set("phone", String(body.phone || "").slice(0, 60));
  if (body.company !== undefined) rec.set("company", String(body.company || "").slice(0, 200));
  if (body.title !== undefined) rec.set("title", String(body.title || "").slice(0, 200));
  if (body.notes !== undefined) rec.set("notes", String(body.notes || "").slice(0, 5000));
  if (body.tags !== undefined) rec.set("tags", Array.isArray(body.tags) ? body.tags : []);
  $app.save(rec);
  e.json(200, { ok: true, contact: contactView(rec) });
}

module.exports = {
  findByEmail,
  threadsForContact,
  upsertFromSender,
  contactView,
  handleGetContacts,
  handleSaveContact
};
