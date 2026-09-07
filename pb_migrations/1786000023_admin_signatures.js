/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — admin (superuser) signatures
// Admins can also handle escalations and reply, so they get the same signature
// support as agents — stored on the _superusers record (agents live in `users`,
// admins in `_superusers`).
//   signature       text  — the admin's email signature
//   signature_auto  bool  — auto-append to replies
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("_superusers");
  } catch (_) { return; }
  const ensureField = (c, f) => { if (!c.fields.getByName(f.name)) c.fields.addMarshaledJSON(JSON.stringify([f])); };
  ensureField(coll, { name: "signature", type: "text", max: 8000 });
  ensureField(coll, { name: "signature_auto", type: "bool" });
  app.save(coll);
  console.log("[gw-mailbox] _superusers.signature / signature_auto fields added");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
