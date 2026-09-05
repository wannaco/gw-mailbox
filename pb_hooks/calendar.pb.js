/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — calendar.pb.js (registrar)
// Engine lives in lib/calendar_engine.js. Handlers inline literal require()
// calls (see main.pb.js header — PB 0.39 handlers only see globals + args).
// =============================================================================

routerAdd("GET", "/api/mailbox/threads/{id}/availability", (e) => {
  require(__hooks + "/lib/calendar_engine.js").handleAvailability(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/meet", (e) => {
  require(__hooks + "/lib/calendar_engine.js").handleBookMeet(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/cancel-meet", (e) => {
  require(__hooks + "/lib/calendar_engine.js").handleCancelMeet(e);
}, $apis.requireAuth());

console.log("[gw-mailbox] calendar.pb.js loaded — availability/meet routes registered");
