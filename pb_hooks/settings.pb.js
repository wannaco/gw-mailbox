/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — settings.pb.js (registrar)
// Admin-only settings API: service-account key upload + connection test +
// sync mode. Handlers live in lib/settings_engine.js; guarded by
// $apis.requireAuth() so only the PocketBase admin can call them.
// =============================================================================

routerAdd("GET", "/api/mailbox/settings", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleGetSettings(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/service-account", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSaveServiceAccount(e);
}, $apis.requireAuth());

routerAdd("DELETE", "/api/mailbox/settings/service-account", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleRemoveServiceAccount(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/test-connection", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleTestConnection(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/sync-mode", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSetPollSync(e);
}, $apis.requireAuth());

// --- Mailbox management (admin) ---------------------------------------------
routerAdd("GET", "/api/mailbox/settings/inboxes", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleListInboxes(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/inboxes", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleCreateInbox(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/inboxes/{id}", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleUpdateInbox(e);
}, $apis.requireAuth());

routerAdd("DELETE", "/api/mailbox/settings/inboxes/{id}", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleDeleteInbox(e);
}, $apis.requireAuth());

// --- Label catalog (admin) ---------------------------------------------------
routerAdd("GET", "/api/mailbox/settings/labels", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleListLabels(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/labels", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleCreateLabel(e);
}, $apis.requireAuth());

routerAdd("DELETE", "/api/mailbox/settings/labels/{id}", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleDeleteLabel(e);
}, $apis.requireAuth());

routerAdd("DELETE", "/api/mailbox/settings/canned/{id}", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleDeleteCanned(e);
}, $apis.requireAuth());

// Ticket automations (follow-up / auto-close) config
routerAdd("GET", "/api/mailbox/settings/automations", (e) => {
  require(__hooks + "/lib/automations_engine.js").handleGetAutomations(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/automations", (e) => {
  require(__hooks + "/lib/automations_engine.js").handleSaveAutomations(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/mention-admins", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSetMentionAdmins(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/sla", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSaveSla(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/csat", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSaveCsat(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/users/{id}/signature", (e) => {
  require(__hooks + "/lib/settings_engine.js").handleSaveAgentSignature(e);
}, $apis.requireAuth());

routerAdd("POST", "/api/mailbox/settings/automations/run", (e) => {
  require(__hooks + "/lib/automations_engine.js").handleRunNow(e);
}, $apis.requireAuth());

console.log("[gw-mailbox] settings.pb.js loaded — admin settings routes registered");

