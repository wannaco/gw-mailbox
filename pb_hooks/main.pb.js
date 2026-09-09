/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — main.pb.js (registrar)
//
// PB 0.39 quirk: routerAdd/cronAdd handlers execute with ONLY globals + args
// in scope — no closures, no load-time module refs, no top-level bindings.
// Handlers must inline literal require() calls (verified pattern).
// Handlers live in lib/presence_api.js.
// =============================================================================

// ---------------------------------------------------------------------------
// Routes — presence / draft lock / internal notes / kanban moves / me
// ---------------------------------------------------------------------------
routerAdd("GET", "/api/mailbox/me", (e) => {
  require(__hooks + "/lib/presence_api.js").handleMe(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/me/signature", (e) => {
  require(__hooks + "/lib/presence_api.js").handleSaveMySignature(e);
}, $apis.requireAuth());

routerAdd("GET", "/api/mailbox/users", (e) => {
  require(__hooks + "/lib/presence_api.js").handleDirectory(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/presence/beat", (e) => {
  require(__hooks + "/lib/presence_api.js").handlePresenceBeat(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/presence/offline", (e) => {
  require(__hooks + "/lib/presence_api.js").handlePresenceOffline(e);
}, $apis.requireAuth());

routerAdd("GET", "/api/mailbox/presence/roster", (e) => {
  require(__hooks + "/lib/presence_api.js").handleRoster(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/presence", (e) => {
  require(__hooks + "/lib/presence_api.js").handlePresenceHeartbeat(e);
}, $apis.requireAuth());

routerAdd("GET", "/api/mailbox/threads/{id}/presence", (e) => {
  require(__hooks + "/lib/presence_api.js").handlePresenceSnapshot(e);
}, $apis.requireAuth());

routerAdd("DELETE", "/api/mailbox/threads/{id}/presence", (e) => {
  require(__hooks + "/lib/presence_api.js").handlePresenceRelease(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/notes", (e) => {
  require(__hooks + "/lib/presence_api.js").handleAddInternalNote(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/move", (e) => {
  require(__hooks + "/lib/presence_api.js").handleMoveThread(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/bulk", (e) => {
  require(__hooks + "/lib/presence_api.js").handleBulkThreads(e);
}, $apis.requireAuth());

// --- Notifications (mentions / notes) ----------------------------------------
routerAdd("GET", "/api/mailbox/notifications", (e) => {
  require(__hooks + "/lib/notifications_engine.js").handleListNotifications(e);
}, $apis.requireAuth());

// --- Contacts ----------------------------------------------------------------
routerAdd("GET", "/api/mailbox/contacts", (e) => {
  require(__hooks + "/lib/contacts_engine.js").handleGetContacts(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/contacts/save", (e) => {
  require(__hooks + "/lib/contacts_engine.js").handleSaveContact(e);
}, $apis.requireAuth());

// --- Reports ----------------------------------------------------------------
routerAdd("GET", "/api/mailbox/reports", (e) => {
  require(__hooks + "/lib/reports_engine.js").handleReports(e);
}, $apis.requireAuth());

// --- Admin utilities ---------------------------------------------------------
// Manual SLA-monitor trigger so a breach can be enforced immediately (and be
// verified on demand) instead of waiting for the next hourly tick.
routerAdd("POST", "/api/mailbox/admin/run-sla-monitor", (e) => {
  require(__hooks + "/lib/cron_engine.js").handleRunSlaMonitor(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/notifications/{id}/read", (e) => {
  require(__hooks + "/lib/notifications_engine.js").handleMarkRead(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/notifications/read-all", (e) => {
  require(__hooks + "/lib/notifications_engine.js").handleMarkAllRead(e);
}, $apis.requireAuth());

// ---------------------------------------------------------------------------
// Record hooks — lifecycle normalization. These closures only use globals
// ($os, DateTime, $app) and were verified to run from request contexts.
// ---------------------------------------------------------------------------

// New threads start on the "new" column; SLA defaults to now + sla_hours
// from app_settings (Settings -> SLA), falling back to MAILBOX_SLA_HOURS env
// and then 24 — unless the ingest engine already set sla_due_at.
onRecordCreate((e) => {
  const rec = e.record;
  if (!rec.getString("status")) rec.set("status", "new");
  const sla = rec.getDateTime("sla_due_at");
  if (!sla || sla.isZero()) {
    let hours = 24;
    try {
      const env = parseInt($os.getenv("MAILBOX_SLA_HOURS") || "24", 10);
      hours = !isNaN(env) && env > 0 ? env : 24;
      const s = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
      if (s) {
        const v = s.get("sla_hours");
        const n = (v === undefined || v === null || v === "") ? hours : Number(v);
        if (!isNaN(n) && n > 0) hours = n;
      }
    } catch (_) { /* settings row may not exist yet */ }
    rec.set("sla_due_at", new DateTime().add(hours * 3600 * 1e9));
  }
  e.next();
}, "threads");

// Presence rows always carry a server-side heartbeat timestamp so the sweeper
// and freshness checks never trust the client clock.
onRecordCreate((e) => {
  e.record.set("updated_at", new DateTime());
  e.next();
}, "thread_presence");
onRecordUpdate((e) => {
  e.record.set("updated_at", new DateTime());
  e.next();
}, "thread_presence");

console.log("[gw-mailbox] main.pb.js loaded — presence/notes/move routes registered");
