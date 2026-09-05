/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — cron.pb.js (registrar)
// Jobs live in lib/cron_engine.js. Cron callbacks only see globals, so each
// run re-requires the engine inline (see main.pb.js header).
//   gw-sla-monitor       hourly  — escalate `new` tickets past sla_due_at
//   gw-presence-sweeper  every m — delete thread_presence older than 2 min
// =============================================================================

cronAdd("gw-sla-monitor", "0 * * * *", () => {
  require(__hooks + "/lib/cron_engine.js").runSlaMonitor();
});

cronAdd("gw-presence-sweeper", "* * * * *", () => {
  require(__hooks + "/lib/cron_engine.js").runPresenceSweeper();
});

cronAdd("gw-mail-poll-sync", "* * * * *", () => {
  require(__hooks + "/lib/cron_engine.js").runMailPollSync();
});

console.log("[gw-mailbox] cron.pb.js loaded — SLA monitor (hourly) + presence sweeper (every min) registered");
