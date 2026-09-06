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

routerAdd("GET", "/api/mailbox/users", (e) => {
  require(__hooks + "/lib/presence_api.js").handleDirectory(e);
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

// ---------------------------------------------------------------------------
// Record hooks — lifecycle normalization. These closures only use globals
// ($os, DateTime, $app) and were verified to run from request contexts.
// ---------------------------------------------------------------------------

// New threads start on the "new" column; SLA defaults to now + MAILBOX_SLA_HOURS
// (24) unless the ingest engine already set sla_due_at.
onRecordCreate((e) => {
  const rec = e.record;
  if (!rec.getString("status")) rec.set("status", "new");
  const sla = rec.getDateTime("sla_due_at");
  if (!sla || sla.isZero()) {
    const hours = parseInt($os.getenv("MAILBOX_SLA_HOURS") || "24", 10);
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
