/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — admin mention opt-in
// Superusers/admins are NOT in the `users` collection, so agents can't @-mention
// them and they can't be notified. This stores which admin(s) opted in to being
// mentionable (list of _superusers record ids in app_settings.mention_admin_ids).
// =============================================================================
migrate((app) => {
  const as = app.findCollectionByNameOrId("app_settings");
  if (!as.fields.getByName("mention_admin_ids")) {
    as.fields.addMarshaledJSON(JSON.stringify([
      { name: "mention_admin_ids", type: "json", maxSize: 20000 }
    ]));
    app.save(as);
    console.log("[gw-mailbox] app_settings.mention_admin_ids field added");
  }
}, (app) => {
  // Downgrade: leave the field (non-destructive).
});
