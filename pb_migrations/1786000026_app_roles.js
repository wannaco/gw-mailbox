/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — application roles (users.role)
//
// The app used to reuse PocketBase's `_superusers` collection as its "admin"
// concept, which conflated two unrelated things:
//   * infrastructure access  — DB root: dashboard, schema, backups, recovery
//   * the application role   — runs Settings, mailboxes, agents, reports
// That shortcut cost us a duplicated signature schema, two /me branches, an
// invented "mentionable admins" list, ~22 isSuperuser special-cases, no SSO for
// admins (PB hard-disables OAuth2 on system collections), and — worst — a
// ROOT database token stored in the browser localStorage and sent on every
// request.
//
// Fix: the app gets its own role on `users`:
//   users.role = "agent" | "admin"    (default "agent")
//
// `_superusers` remains, but only for break-glass ops (dashboard at /_/, CLI,
// backups). The app never authenticates against it again. Each superuser also
// gets a matching `users` record with role="admin" so admins are ordinary app
// users: Google SSO works, they are assignable/mentionable, one signature path.
// =============================================================================
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  // 1) role field
  if (!users.fields.getByName("role")) {
    users.fields.addMarshaledJSON(JSON.stringify([{
      name: "role",
      type: "select",
      values: ["agent", "admin"],
      maxSelect: 1
    }]));
    app.save(users);
    console.log("[gw-mailbox] users.role added (agent|admin)");
  } else {
    console.log("[gw-mailbox] users.role already exists");
  }

  // 2) Every superuser gets a matching app user with role=admin, so they can
  //    sign in through the normal app login (Google included) and behave as a
  //    teammate. No password is set — sign in with Google, or an admin can set
  //    one later from the app.
  let supers = [];
  try {
    supers = app.findRecordsByFilter("_superusers", "", "", 0, 0) || [];
  } catch (_) { supers = []; }

  let created = 0, promoted = 0;
  for (const su of supers) {
    const email = String(su.getString("email") || "").trim().toLowerCase();
    if (!email) continue;
    try {
      const found = app.findRecordsByFilter("users", "email = {:e}", "", 1, 0, { e: email });
      const rec = (found && found.length) ? found[0] : null;
      if (rec) {
        if ((rec.getString("role") || "") !== "admin") {
          rec.set("role", "admin");
          app.save(rec);
          promoted++;
        }
      } else {
        const u = new Record(users, {
          email: email,
          name: su.getString("name") || "Admin",
          role: "admin",
          verified: true
        });
        // `users` is an AUTH collection → password is mandatory. Set a long
        // random throwaway: the admin signs in with Google (or an admin sets a
        // real password later). Nothing here is guessable.
        u.setPassword($security.randomString(32));
        app.save(u);
        created++;
      }
    } catch (err) {
      console.log("[gw-mailbox] role bootstrap skipped for " + email + ": " + ((err && err.message) || err));
    }
  }
  console.log("[gw-mailbox] app roles ready: " + created + " admin user(s) created, " + promoted + " promoted");
}, (app) => {
  // Downgrade: leave the role field + records (non-destructive).
});
