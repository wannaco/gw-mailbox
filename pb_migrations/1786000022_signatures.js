/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — agent signatures
// Adds to the `users` auth collection (agents):
//   signature       text  — the agent's email signature (multi-line text)
//   signature_auto  bool  — auto-append the signature to replies (Gmail-style)
// Agents set their own from the Profile screen; admins can set it on their
// behalf (Settings → People → Agents & signatures). Only relevant to the
// users collection — superusers aren't agents.
// =============================================================================
migrate((app) => {
  let users;
  try {
    users = app.findCollectionByNameOrId("users");
  } catch (_) { return; }
  const ensureField = (coll, f) => { if (!coll.fields.getByName(f.name)) coll.fields.addMarshaledJSON(JSON.stringify([f])); };
  ensureField(users, { name: "signature", type: "text", max: 8000 });
  ensureField(users, { name: "signature_auto", type: "bool" });
  app.save(users);
  console.log("[gw-mailbox] users.signature / signature_auto fields added");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
