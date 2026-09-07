/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — csat.pb.js (registrar)
// Public survey endpoints (token is the auth) + authed thread feedback list.
// Handlers in lib/csat_engine.js.
// =============================================================================

// Public: validate a survey token (renders the form / thank-you state).
routerAdd("GET", "/api/mailbox/csat/{token}", (e) => {
  require(__hooks + "/lib/csat_engine.js").handleCsatGet(e);
});

// Public: submit a rating + comment.
routerAdd("POST", "/api/mailbox/csat/submit", (e) => {
  require(__hooks + "/lib/csat_engine.js").handleCsatSubmit(e);
});

// Authed: list CSAT rows for a thread (agent drawer).
routerAdd("GET", "/api/mailbox/threads/{id}/csat", (e) => {
  require(__hooks + "/lib/csat_engine.js").handleThreadCsat(e);
}, $apis.requireAuth());

console.log("[gw-mailbox] csat.pb.js loaded — public survey + thread CSAT routes registered");
