/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — gmail.pb.js (registrar)
// Engine lives in lib/gmail_engine.js. Handlers inline literal require() calls
// (see main.pb.js header — PB 0.39 handlers only see globals + args).
// =============================================================================

routerAdd("GET", "/api/gmail-webhook", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleWebhookProbe(e);
});

routerAdd("POST", "/api/gmail-webhook", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleWebhookPush(e);
});

routerAdd("POST", "/api/mailbox/inboxes/{id}/watch", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleWatch(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/inboxes/{id}/sync", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleSync(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/inboxes/{id}/backfill", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleBackfill(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/threads/{id}/reply", (e) => {
  require(__hooks + "/lib/gmail_engine.js").handleReply(e);
}, $apis.requireAuth());

console.log("[gw-mailbox] gmail.pb.js loaded — webhook + watch/sync routes registered");
