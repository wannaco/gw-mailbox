/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — seed_demo.pb.js (registrar)
// When MAILBOX_SEED_DEMO=1, register a one-shot cron job that seeds demo
// agents/inboxes/threads on first boot (runs after migrations exist).
// =============================================================================

if ($os.getenv("MAILBOX_SEED_DEMO") === "1") {
  cronAdd("gw-seed-demo", "* * * * *", () => {
    require(__hooks + "/lib/seed_demo.js").trySeed();
  });
}

console.log("[gw-mailbox] seed_demo.pb.js loaded" +
  ($os.getenv("MAILBOX_SEED_DEMO") === "1" ? " (demo seed enabled)" : " (demo seed disabled)"));
