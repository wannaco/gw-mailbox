// =============================================================================
// gw-mailbox — follow-up / auto-close automations engine
// Configurable from Settings -> Ticket automations (app_settings row).
//
// Rules (per ticket in "waiting_customer"):
//   - No follow-up yet: due once `last_message_at + followup_delay_h` passes.
//   - Follow-ups sent: due again once `followup_next_at` passes.
//   - While followup_sent < followup_max: send a nudge email to the customer.
//   - When followup_sent >= followup_max (and autoclose_enabled): auto-close.
//   - Any real customer reply resets the counters (handled in gmail ingest).
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

var CFG_DEFAULTS = {
  followup_enabled: false,
  followup_delay_h: 48,
  followup_interval_h: 48,
  followup_max: 2,
  autoclose_enabled: true,
  followup_subject: "",
  followup_body: "Hi {{customer_name}}, just checking in — do you still need help with \"{{subject}}\"? We're happy to keep assisting whenever you're ready."
};

function cfgBool(rec, name, dflt) {
  try { return rec.getBool(name); } catch (_) { return dflt; }
}
// Honor 0 as a valid value (getInt(...) || dflt treats 0 as missing).
function cfgNum(rec, name, dflt) {
  try {
    const v = rec.get(name);
    if (v === undefined || v === null || v === "") return dflt;
    const n = Number(v);
    return isNaN(n) ? dflt : n;
  } catch (_) { return dflt; }
}

function readAutoConfig() {
  const out = Object.assign({}, CFG_DEFAULTS);
  try {
    const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    out.followup_enabled = cfgBool(rec, "followup_enabled", CFG_DEFAULTS.followup_enabled);
    out.followup_delay_h = cfgNum(rec, "followup_delay_h", CFG_DEFAULTS.followup_delay_h);
    out.followup_interval_h = cfgNum(rec, "followup_interval_h", CFG_DEFAULTS.followup_interval_h);
    out.followup_max = Math.max(1, cfgNum(rec, "followup_max", CFG_DEFAULTS.followup_max));
    out.autoclose_enabled = cfgBool(rec, "autoclose_enabled", CFG_DEFAULTS.autoclose_enabled);
    out.followup_subject = rec.getString("followup_subject") || "";
    out.followup_body = rec.getString("followup_body") || CFG_DEFAULTS.followup_body;
  } catch (_) { /* row may not exist yet */ }
  return out;
}

function saveAutoConfig(cfg) {
  const coll = $app.findCollectionByNameOrId("app_settings");
  let rec = null;
  try { rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'"); } catch (_) { /* */ }
  if (!rec) {
    rec = new Record(coll, { key: "instance" });
  }
  rec.set("followup_enabled", !!cfg.followup_enabled);
  rec.set("followup_delay_h", Math.max(0, parseInt(cfg.followup_delay_h, 10) || 0));
  rec.set("followup_interval_h", Math.max(0, parseInt(cfg.followup_interval_h, 10) || 0));
  rec.set("followup_max", Math.max(1, parseInt(cfg.followup_max, 10) || 1));
  rec.set("autoclose_enabled", !!cfg.autoclose_enabled);
  rec.set("followup_subject", String(cfg.followup_subject || "").slice(0, 300));
  rec.set("followup_body", String(cfg.followup_body || "").slice(0, 12000));
  $app.save(rec);
  return readAutoConfig();
}

// Reset a thread's follow-up state (fresh waiting period / customer replied).
function resetFollowups(threadRec) {
  if (!threadRec) return;
  try {
    threadRec.set("followup_sent", 0);
    threadRec.set("followup_next_at", "");
    threadRec.set("followup_last_at", "");
    $app.save(threadRec);
  } catch (err) {
    h.warn("followup reset failed", threadRec.id, (err && err.message) || err);
  }
}

function fillTemplate(tpl, threadRec) {
  const vars = {
    "{{customer_name}}": threadRec.getString("customer_name") || threadRec.getString("customer_email") || "",
    "{{customer_email}}": threadRec.getString("customer_email") || "",
    "{{subject}}": threadRec.getString("subject") || "(no subject)",
    "{{inbox}}": ""
  };
  // resolve inbox email
  try {
    const inbox = h.safeFindById("inboxes", threadRec.getString("inbox"));
    vars["{{inbox}}"] = inbox ? inbox.getString("email_address") : "";
  } catch (_) { /* ignore */ }
  let out = String(tpl || "");
  for (const k in vars) out = out.split(k).join(vars[k]);
  return out;
}

function threadDue(threadRec, cfg, now) {
  const count = threadRec.getInt("followup_sent") || 0;
  if (count === 0) {
    // no follow-up sent yet -> due after the initial delay from last activity
    const last = threadRec.getDateTime("last_message_at");
    if (!last || last.isZero()) return false;
    const due = new DateTime().add(-cfg.followup_delay_h * 3600 * 1e9);
    return last.before(due) || last.string() === due.string();
  }
  const next = threadRec.getDateTime("followup_next_at");
  if (!next || next.isZero()) return false;
  return !next.after(new DateTime());
}

function handleThread(threadRec, cfg) {
  const count = threadRec.getInt("followup_sent") || 0;
  const uid = (() => {
    try {
      const inbox = h.safeFindById("inboxes", threadRec.getString("inbox"));
      return inbox ? inbox.getString("email_address") : "";
    } catch (_) { return ""; }
  })();

  // 1) max reached -> auto-close (if enabled)
  if (count >= cfg.followup_max) {
    if (!cfg.autoclose_enabled) return; // stop nudging, leave as-is
    threadRec.set("status", "closed");
    threadRec.set("followup_next_at", "");
    $app.save(threadRec);
    h.markThreadClosed(threadRec); // reports: stamp closed_at
    h.addInternalNote(threadRec.id,
      { name: "Automation", email: "system@mailbox.local" },
      "Auto-closed: no customer reply after " + count + " follow-up" + (count === 1 ? "" : "s") + "."
    );
    // Auto-close -> fire the CSAT survey to the customer.
    try {
      require(__hooks + "/lib/csat_engine.js").dispatchCsatOnClose(threadRec.id);
    } catch (_) { /* non-fatal */ }
    // notify the assignee so they know it was closed automatically
    const assignee = threadRec.getString("assigned_agent");
    if (assignee) {
      try {
        require(__hooks + "/lib/notifications_engine.js").notify(
          assignee, "note", threadRec.id, threadRec.getString("subject") || "(no subject)",
          "", "Automation", "Ticket auto-closed after " + count + " follow-up(s) with no reply."
        );
      } catch (_) { /* non-fatal */ }
    }
    h.log("follow-up automation: auto-closed", threadRec.id, "after", count, "nudge(s)");
    return;
  }

  // 2) still below max -> send the next follow-up nudge
  if (!uid || !threadRec.getString("customer_email")) return;
  // Nudge MUST reuse the thread's EXACT subject (no "Re:" prefix, no suffix) —
  // any subject change makes Gmail deliver it as a NEW conversation.
  const subject = cfg.followup_subject && String(cfg.followup_subject).trim()
    ? fillTemplate(cfg.followup_subject, threadRec)
    : (threadRec.getString("subject") || "(no subject)");
  const body = fillTemplate(cfg.followup_body, threadRec);

  try {
    const ge = require(__hooks + "/lib/gmail_engine.js");
    ge.sendOutboundEmail(threadRec, uid, subject, body);
    threadRec.set("followup_sent", count + 1);
    threadRec.set("followup_last_at", h.dateToPbString(new Date()));
    threadRec.set("followup_next_at", new DateTime().add(cfg.followup_interval_h * 3600 * 1e9).string());
    $app.save(threadRec);
    h.addInternalNote(threadRec.id,
      { name: "Automation", email: "system@mailbox.local" },
      "Follow-up #" + (count + 1) + " sent to customer (auto nudge)."
    );
    h.log("follow-up automation: nudge #" + (count + 1), "sent on", threadRec.id);
  } catch (err) {
    h.warn("follow-up send failed for", threadRec.id, (err && err.message) || err);
    throw err; // surface to run-now / cron per-thread catcher
  }
}

function runFollowupAutomations() {
  let cfg;
  try { cfg = readAutoConfig(); } catch (_) { return; }
  if (!cfg.followup_enabled) return;
  try {
    const rows = $app.findRecordsByFilter("threads", "status = {:s}", "", 0, 0, { s: "waiting_customer" }) || [];
    for (const t of rows) {
      try {
        if (!threadDue(t, cfg)) continue;
        handleThread(t, cfg);
      } catch (err) {
        h.warn("follow-up automation error", t.id, (err && err.message) || err);
      }
    }
  } catch (err) {
    h.warn("follow-up automation scan failed", (err && err.message) || err);
  }
}

// Route handlers (admin settings) --------------------------------------------
function handleGetAutomations(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isSuperuser) return h.fail(e, 403, "admin_required", "Superuser access required");
  e.json(200, { ok: true, automation: readAutoConfig() });
}

// Manual "run now" (superuser) — processes every due waiting_customer ticket
// and returns a per-thread summary (useful for testing + ops).
function handleRunNow(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isSuperuser) return h.fail(e, 403, "admin_required", "Superuser access required");
  const cfg = readAutoConfig();
  const out = { ok: true, enabled: cfg.followup_enabled, processed: 0, actions: [], errors: [] };
  try {
    const rows = $app.findRecordsByFilter("threads", "status = {:s}", "", 0, 0, { s: "waiting_customer" }) || [];
    for (const t of rows) {
      try {
        if (!threadDue(t, cfg)) { out.actions.push({ id: t.id, result: "not_due" }); continue; }
        const before = t.getInt("followup_sent") || 0;
        handleThread(t, cfg);
        out.processed++;
        const after = t.getInt("followup_sent") || 0;
        const st = t.getString("status");
        out.actions.push({ id: t.id, result: after > before ? "nudge_sent" : (st === "closed" ? "auto_closed" : "noop"), followup_sent: after, status: st });
      } catch (err) {
        out.errors.push({ id: t.id, error: (err && err.message) || String(err) });
      }
    }
  } catch (err) {
    out.ok = false;
    out.errors.push({ scan: (err && err.message) || String(err) });
  }
  e.json(200, out);
}

function handleSaveAutomations(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor || !actor.isSuperuser) return h.fail(e, 403, "admin_required", "Superuser access required");
  let body = {};
  try { body = JSON.parse(toString(e.request.body) || "{}"); } catch (_) { body = {}; }
  const saved = saveAutoConfig(body.automation || body);
  e.json(200, { ok: true, automation: saved });
}

module.exports = {
  readAutoConfig,
  saveAutoConfig,
  resetFollowups,
  runFollowupAutomations,
  handleGetAutomations,
  handleSaveAutomations,
  handleRunNow
};
