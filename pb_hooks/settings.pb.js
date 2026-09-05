/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — settings.pb.js (registrar)
// Admin-only settings API: service-account key upload + connection test +
// sync mode. Handlers live in lib/settings_engine.js; guarded by
// $apis.requireSuperuserAuth() so only the PocketBase admin can call them.
// =============================================================================

routerAdd("GET", "/api/mailbox/settings", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleGetSettings(e);
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/mailbox/settings/service-account", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSaveServiceAccount(e);
}, $apis.requireSuperuserAuth());

routerAdd("DELETE", "/api/mailbox/settings/service-account", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleRemoveServiceAccount(e);
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/mailbox/settings/test-connection", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleTestConnection(e);
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/mailbox/settings/sync-mode", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSetPollSync(e);
}, $apis.requireSuperuserAuth());

console.log("[gw-mailbox] settings.pb.js loaded — admin settings routes registered");

