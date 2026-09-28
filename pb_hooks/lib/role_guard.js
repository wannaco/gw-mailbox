// =============================================================================
// gw-mailbox — role change guard
//
// WHY THIS EXISTS
//
// `users.role` ("agent" | "admin") is what the app gates on:
//   settings_engine  requireAdmin()  -> service-account settings
//   presence_api     actor.isAdmin   -> every active inbox, not just granted ones
//   reports_engine   actor.isAdmin   -> all-inbox reporting
//
// But users.updateRule is `@request.auth.id = id`, which lets ANY signed-in user
// PATCH their own record — and PocketBase rules are record-level, so they cannot
// express "anything except this field". Verified on PB 0.39.0:
//
//     agent logs in                        -> role: "agent"
//     PATCH /api/collections/users/records/<self>  {"role":"admin"}
//       -> HTTP 200
//     re-login                             -> role: "admin"      <-- escalated
//
// So an ordinary agent could promote themselves and then see every inbox —
// all customer email — and reach the service-account settings. The role
// enforcement was correct; only the field was self-assignable. This closes that.
//
// ENFORCED HERE, NOT IN A RULE, because a rule cannot exclude one field. Only an
// admin (or a PocketBase superuser) may change `role`; anyone else gets 403.
//
// FAILS CLOSED: if the before/after comparison itself throws, the request is
// treated as a role change and refused. A guard that silently stops firing is
// worse than no guard, because it looks protected.
//
// `users.createRule` is already `null` (superuser-only), so creation needs no
// guard — a non-superuser cannot create a user at all.
//
// NOTE: `e.auth` is the caller. Do NOT use `e.httpContext` — it is undefined
// inside onRecordUpdateRequest (probed on 0.39.0 and 0.40.4; it throws, and the
// guard then silently never applies).
// =============================================================================

function guardRoleChange(e) {
  var changed = false;
  try {
    var newRole = String(e.record.getString("role") || "");
    var oldRole = "";
    try {
      var orig = e.record.original();
      if (orig) oldRole = String(orig.getString("role") || "");
    } catch (_) { oldRole = ""; }
    changed = (newRole !== oldRole);
  } catch (_) {
    // Could not compare -> assume it changed and refuse. Safe direction.
    changed = true;
  }

  if (!changed) { e.next(); return; }

  var allowed = false;
  try { if (e.hasSuperuserAuth && e.hasSuperuserAuth()) allowed = true; } catch (_) { allowed = false; }
  if (!allowed) {
    try {
      var h = require(__hooks + "/lib/helpers.js");
      var actor = h.actorFromEvent(e);
      if (actor && actor.isAdmin) allowed = true;
    } catch (_) { allowed = false; }
  }

  if (!allowed) {
    throw new ForbiddenError("Only an administrator can change a user's role.");
  }
  e.next();
}

module.exports = { guardRoleChange: guardRoleChange };
