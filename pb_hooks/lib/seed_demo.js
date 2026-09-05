// =============================================================================
// gw-mailbox — demo seed engine (module)
// Seeds demo agents / inboxes / threads when MAILBOX_SEED_DEMO=1 and the
// inboxes collection is empty. Runs inside a one-minute cron job (see
// seed_demo.pb.js) so it executes AFTER the schema migration on first boot.
// =============================================================================

var seeded = false;

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function iso(d) {
  return new DateTime(d).string();
}

function trySeed() {
  if (seeded) return "done";
  if ($os.getenv("MAILBOX_SEED_DEMO") !== "1") {
    seeded = true; // nothing to do, stop ticking
    return "disabled";
  }
  try {
    // collections exist yet?
    $app.findCollectionByNameOrId("inboxes");
  } catch (_) {
    return "not_ready"; // migrations not applied yet — retry next tick
  }

  try {
    const existing = $app.findRecordsByFilter("inboxes", "", "", 1, 0);
    if (existing && existing.length) {
      seeded = true; // already has data — never overwrite
      return "skip_existing";
    }

    const usersColl = $app.findCollectionByNameOrId("users");

    function ensureUser(email, name) {
      let u = null;
      try {
        u = $app.findFirstRecordByFilter("users", "email = {:e}", { e: email });
      } catch (_) { /* not found */ }
      if (u) return u;
      u = new Record(usersColl, { email: email, name: name, verified: true });
      u.setPassword("<<CREDENTIAL-REMOVED>>");
      $app.save(u);
      return u;
    }

    const alice = ensureUser("alice@demo.local", "Alice Agent");
    const bob = ensureUser("bob@demo.local", "Bob Agent");

    const teamsColl = $app.findCollectionByNameOrId("teams");
    let team = null;
    try {
      team = $app.findFirstRecordByFilter("teams", "name = {:n}", { n: "Demo Support L1" });
    } catch (_) { /* not found */ }
    if (!team) {
      team = new Record(teamsColl, { name: "Demo Support L1", description: "Demo team" });
      team.set("members", [alice.id, bob.id]);
      $app.save(team);
    }

    const inboxesColl = $app.findCollectionByNameOrId("inboxes");
    const both = [alice.id, bob.id];
    function ensureInbox(name, email) {
      const rec = new Record(inboxesColl, {
        name: name,
        email_address: email,
        is_active: true,
        history_id: ""
      });
      rec.set("allowed_users", both);
      rec.set("allowed_teams", [team.id]);
      $app.save(rec);
      return rec;
    }

    const support = ensureInbox("Support", "support@demo.local");
    const sales = ensureInbox("Sales", "sales@demo.local");
    const billing = ensureInbox("Billing", "billing@demo.local");

    const threadsColl = $app.findCollectionByNameOrId("threads");
    const messagesColl = $app.findCollectionByNameOrId("messages");
    const now = Date.now();
    const H = 3600 * 1000;

    function addMessage(threadId, sender, recipient, plain, html, whenIso, note) {
      const m = new Record(messagesColl, {
        thread: threadId,
        sender_email: sender,
        recipient_emails: [recipient],
        body_plain: plain,
        body_html: html || "<p>" + esc(plain).replace(/\n+/g, "</p><p>") + "</p>",
        is_internal_note: !!note
      });
      if (whenIso) { try { m.set("created", whenIso); } catch (_) { /* autodate ignores manual */ } }
      $app.save(m);
      return m;
    }

    function addThread(inbox, subject, customerName, customerEmail, status, hoursAgo, extra) {
      extra = extra || {};
      const t = new Record(threadsColl, {
        inbox: inbox.id,
        gmail_thread_id: "demo-" + $security.randomString(10),
        subject: subject,
        snippet: extra.snippet || "",
        customer_name: customerName,
        customer_email: customerEmail,
        status: status,
        last_message_at: iso(new Date(now - hoursAgo * H).toISOString()),
        tags: extra.tags || []
      });
      const slaHours = extra.escalated ? -(1) : 24;
      t.set("sla_due_at", iso(new Date(now + (slaHours + 1) * H).toISOString()));
      $app.save(t);
      return t;
    }

    // Support inbox threads
    const t1 = addThread(support, "Cannot log into the customer portal", "Marina Klein", "marina.klein@outlook.com", "in_progress", 3, {
      snippet: "I've reset my password three times but still get 'invalid credentials'.",
      tags: ["portal", "urgent"]
    });
    addMessage(t1.id, "marina.klein@outlook.com", "support@demo.local",
      "Hi, I've reset my password three times but still get 'invalid credentials'. Can you help?",
      "", iso(new Date(now - 3 * H).toISOString()));
    addMessage(t1.id, "support@demo.local", "marina.klein@outlook.com",
      "Hi Marina — checking your account now, we'll reply shortly.",
      "", iso(new Date(now - 2.5 * H).toISOString()));
    addMessage(t1.id, "alice@demo.local", "support@demo.local",
      "@Bob please pick this up — looks like an SSO mapping issue.",
      "", iso(new Date(now - 2 * H).toISOString()), true);

    const t2 = addThread(support, "Invoice #88412 duplicated charge", "Hassan Ali", "hassan.ali@gmail.com", "new", 1, {
      snippet: "I was charged twice this month. Requesting a refund for the duplicate.",
      tags: ["billing"]
    });
    addMessage(t2.id, "hassan.ali@gmail.com", "support@demo.local",
      "I was charged twice this month on invoice #88412. Requesting a refund for the duplicate.",
      "", iso(new Date(now - 1 * H).toISOString()));

    const t3 = addThread(support, "SSO login broken after domain migration", "Nina Vogel", "nina.vogel@web.de", "escalated", 30, {
      snippet: "Everything worked before the migration to the new identity provider.",
      tags: ["sso", "escalated"],
      escalated: true
    });
    addMessage(t3.id, "nina.vogel@web.de", "support@demo.local",
      "Everything worked before the migration to the new identity provider. Now login times out.",
      "", iso(new Date(now - 30 * H).toISOString()));
    addMessage(t3.id, "bob@demo.local", "support@demo.local",
      "Escalated — infra team investigating IdP connectivity.",
      "", iso(new Date(now - 24 * H).toISOString()), true);

    // Sales inbox
    const t4 = addThread(sales, "Quote for 25-seat enterprise plan", "Omar Farouk", "omar@farouk.dev", "waiting_customer", 6, {
      snippet: "We'd like a custom quote before month end. Also need SSO/SAML.",
      tags: ["enterprise"]
    });
    addMessage(t4.id, "omar@farouk.dev", "sales@demo.local",
      "We'd like a custom quote for 25 seats before month end. SSO/SAML support is a must.",
      "", iso(new Date(now - 6 * H).toISOString()));
    addMessage(t4.id, "sales@demo.local", "omar@farouk.dev",
      "Thanks Omar — sending the proposal + a Meet invite to walk through it.",
      "", iso(new Date(now - 5 * H).toISOString()));

    const t5 = addThread(sales, "Renewal question — annual prepay discount?", "Lucía Pérez", "lucia.perez@corpmail.es", "new", 0.5, {
      snippet: "Our account manager mentioned 10% for annual prepay. Can you confirm?",
      tags: ["renewal"]
    });
    addMessage(t5.id, "lucia.perez@corpmail.es", "sales@demo.local",
      "Our account manager mentioned 10% for annual prepay. Can you confirm before our renewal call?",
      "", iso(new Date(now - 0.5 * H).toISOString()));

    // Billing inbox
    const t6 = addThread(billing, "Refund for cancelled premium plan", "Sam Whitfield", "sam.whitfield@me.com", "closed", 70, {
      snippet: "Refund processed — thanks for the quick turnaround.",
      tags: ["refund"]
    });
    addMessage(t6.id, "sam.whitfield@me.com", "billing@demo.local",
      "Please refund the cancelled premium plan (invoice 7712).",
      "", iso(new Date(now - 70 * H).toISOString()));
    addMessage(t6.id, "billing@demo.local", "sam.whitfield@me.com",
      "Refund processed, you'll see it in 3-5 business days.",
      "", iso(new Date(now - 60 * H).toISOString()));

    console.log("[gw-mailbox] demo seed complete: users/inboxes/threads created");
    seeded = true;
    try { cronRemove("gw-seed-demo"); } catch (_) { /* fine */ }
    return "done";
  } catch (err) {
    console.warn("[gw-mailbox] demo seed failed:", err && err.message ? err.message : err);
    return "error";
  }
}

module.exports = { trySeed: trySeed };
