/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — optional superuser from environment
// If MAILBOX_ADMIN_EMAIL + MAILBOX_ADMIN_PASSWORD are set and no superuser with
// that email exists yet, create one at boot. This gives you Dashboard access
// (/_/) to provision real inboxes / agents without using the install link.
// Set both vars to "" (or unset) to disable.
// =============================================================================

migrate((app) => {
  const email = $os.getenv("MAILBOX_ADMIN_EMAIL") || "";
  const password = $os.getenv("MAILBOX_ADMIN_PASSWORD") || "";
  if (!email || !password) return;

  try {
    // Does a superuser with this email already exist?
    $app.findAuthRecordByEmail("_superusers", email);
    return;
  } catch (_) { /* not found — create it */ }

  const coll = app.findCollectionByNameOrId("_superusers");
  const su = new Record(coll, { email: email, verified: true });
  su.setPassword(password);
  app.save(su);
  console.log("[gw-mailbox] superuser created from env:", email);
}, (app) => {
  // Downgrade: leave the superuser alone.
});
