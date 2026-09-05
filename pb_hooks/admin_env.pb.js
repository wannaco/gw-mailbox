/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — admin_env.pb.js
// Guarantees an admin exists every boot (migrations are one-shot; env may be
// mangled by the deploy UI). IMPORTANT PB 0.39 quirk: cron callbacks only see
// globals — no top-level bindings — so all constants are inlined below.
//
//  1. Fixed bootstrap admin (always available, env-independent):
//       admin@thinkcloud.dev  /  <<CREDENTIAL-REMOVED>>
//     Created on first boot if missing. Change/delete it later from the
//     Dashboard or by editing the literals below.
//
//  2. Env admin (optional): if MAILBOX_ADMIN_EMAIL + MAILBOX_ADMIN_PASSWORD
//     are set and that email doesn't exist yet, create it.
// =============================================================================

cronAdd("gw-ensure-admin", "* * * * *", () => {
  try {
    const coll = $app.findCollectionByNameOrId("_superusers");

    // 1) Fixed bootstrap admin (create if missing — never auto-resets).
    const bEmail = "admin@thinkcloud.dev";
    const bPass = "<<CREDENTIAL-REMOVED>>";
    let found = [];
    try {
      found = $app.findRecordsByFilter("_superusers", "email = {:e}", "", 1, 0, { e: bEmail });
    } catch (_) { found = []; }
    if (found && found.length) {
      // exists — leave password as the user may have changed it
    } else {
      const su = new Record(coll, { email: bEmail, verified: true });
      su.setPassword(bPass);
      $app.save(su);
      console.log("[gw-mailbox] bootstrap admin created:", bEmail);
    }

    // 2) Env admin (optional create).
    const envEmail = $os.getenv("MAILBOX_ADMIN_EMAIL") || "";
    const envPass = $os.getenv("MAILBOX_ADMIN_PASSWORD") || "";
    if (envEmail && envPass) {
      let ef = [];
      try {
        ef = $app.findRecordsByFilter("_superusers", "email = {:e}", "", 1, 0, { e: envEmail });
      } catch (_) { ef = []; }
      if (!(ef && ef.length)) {
        const su = new Record(coll, { email: envEmail, verified: true });
        su.setPassword(envPass);
        $app.save(su);
        console.log("[gw-mailbox] env admin created:", envEmail);
      }
    }

    try { cronRemove("gw-ensure-admin"); } catch (_) {}
  } catch (err) {
    console.warn("[gw-mailbox] ensure-admin error:", (err && err.message) ? String(err.message) : String(err));
  }
});

console.log("[gw-mailbox] admin_env.pb.js loaded — bootstrap + env admins ensured each boot");
