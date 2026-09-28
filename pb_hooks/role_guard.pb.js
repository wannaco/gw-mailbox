/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — role_guard.pb.js (registrar)
//
// Guards `users.role` against self-promotion. See lib/role_guard.js for why this
// cannot be a collection rule: users.updateRule is "@request.auth.id = id", so a
// rule cannot exclude the one field that grants privilege.
//
// Logic lives in lib/role_guard.js — hook callbacks must inline a literal
// require() (PB 0.39: callbacks only see globals + args).
// =============================================================================

onRecordUpdateRequest((e) => {
  require(__hooks + "/lib/role_guard.js").guardRoleChange(e);
}, "users");

console.log("[gw-mailbox] role_guard.pb.js loaded — users.role can only be set by an admin");
