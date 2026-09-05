/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — admin_env.pb.js
// Ensures a superuser exists from env EVERY boot (not a one-time migration —
// migrations are skipped once applied, which is why env-superuser failed).
// Runs every minute until the superuser exists, then unregisters.
//   MAILBOX_ADMIN_EMAIL + MAILBOX_ADMIN_PASSWORD (both required to enable)
// =============================================================================

cronAdd("gw-ensure-admin", "* * * * *", () => {
  const email = $os.getenv("MAILBOX_ADMIN_EMAIL") || "";
  const password = $os.getenv("MAILBOX_ADMIN_PASSWORD") || "";
  if (!email || !password) return; // not configured — retry harmlessly

  try {
    // Already exists?
    try {
      $app.findAuthRecordByEmail("_superusers", email);
      try { cronRemove("gw-ensure-admin"); } catch (_) {}
      return;
    } catch (_) { /* not found — create */ }

    const coll = $app.findCollectionByNameOrId("_superusers");
    const su = new Record(coll, { email: email, verified: true });
    su.setPassword(password);
    $app.save(su);
    console.log("[gw-mailbox] superuser created from env:", email);
    try { cronRemove("gw-ensure-admin"); } catch (_) {}
  } catch (err) {
    console.warn("[gw-mailbox] ensure-admin error:", err && err.message ? err.message : err);
  }
});

console.log("[gw-mailbox] admin_env.pb.js loaded — env superuser ensured on each boot");
