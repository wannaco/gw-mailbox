/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — zz_bootstrap.pb.js (registrar)
//
// Env-driven host bootstrap so a fresh install works on ANY domain with no
// manual clicking: PocketBase appURL from MAILBOX_PUBLIC_URL, first superuser
// from MAILBOX_ADMIN_EMAIL/PASSWORD, and the public link base.
//
// WHY A CRON (and not onBootstrap): the bootstrap hook fires before the DB /
// settings are fully initialised, and touching them there panics inside goja
// (nil pointer, uncatchable → the server exits). A cron callback runs after
// boot with everything ready, and the job is idempotent + silent unless it
// actually changes something, so a per-minute tick costs nothing.
//
// Logic lives in lib/bootstrap_engine.js — callbacks must inline a literal
// require() (PB 0.39: hook callbacks only see globals + args).
// =============================================================================

cronAdd("gw-bootstrap", "* * * * *", () => {
  require(__hooks + "/lib/bootstrap_engine.js").runBootstrap();
});

console.log("[gw-mailbox] zz_bootstrap.pb.js loaded — env bootstrap scheduled (per-minute, idempotent)");
