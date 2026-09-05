/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — admin_env.pb.js
// Ensures the env superuser exists AND that its password matches the env on
// every boot (migrations are one-shot, so this uses a cron). Source of truth:
//   MAILBOX_ADMIN_EMAIL + MAILBOX_ADMIN_PASSWORD
// If the email exists -> reset its password to MAILBOX_ADMIN_PASSWORD.
// If missing       -> create it.
// Then unregisters the job.
// =============================================================================

cronAdd("gw-ensure-admin", "* * * * *", () => {
  const email = $os.getenv("MAILBOX_ADMIN_EMAIL") || "";
  const password = $os.getenv("MAILBOX_ADMIN_PASSWORD") || "";
  if (!email || !password) return; // not configured — retry harmlessly

  try {
    let existing = null;
    try {
      const found = $app.findRecordsByFilter("_superusers", "email = {:e}", "", 1, 0, { e: email });
      existing = (found && found.length) ? found[0] : null;
    } catch (_) { existing = null; }

    const coll = $app.findCollectionByNameOrId("_superusers");
    if (existing) {
      // Reset password to env so the Dokploy value is always the login.
      existing.setPassword(password);
      $app.save(existing);
      console.log("[gw-mailbox] admin superuser password synced to env:", email);
    } else {
      const su = new Record(coll, { email: email, verified: true });
      su.setPassword(password);
      $app.save(su);
      console.log("[gw-mailbox] superuser created from env:", email);
    }
    try { cronRemove("gw-ensure-admin"); } catch (_) {}
  } catch (err) {
    console.warn("[gw-mailbox] ensure-admin error:", (err && err.message) ? String(err.message) : String(err));
  }
});

console.log("[gw-mailbox] admin_env.pb.js loaded — env admin ensured/synced each boot");
