/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — app_settings singleton (admin-managed connection settings)
// Lets a superuser store the Google service-account key + sync prefs from the
// Settings UI instead of env vars. Single row identified by key="instance".
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("app_settings");
  } catch (_) {
    coll = new Collection({
      name: "app_settings",
      type: "base",
      fields: [
        { name: "key", type: "text", required: true, max: 100 },
        { name: "poll_sync", type: "bool" },
        { name: "service_account_key", type: "text", max: 20000 },
        { name: "key_client_email", type: "text", max: 300 }
      ]
    });
    // Superuser-only: agents never see connection secrets.
    coll.listRule = null;
    coll.viewRule = null;
    coll.createRule = null;
    coll.updateRule = null;
    coll.deleteRule = null;
    app.save(coll);
  }

  // Ensure the singleton row exists.
  try {
    app.findFirstRecordByFilter("app_settings", "key = 'instance'");
  } catch (_) {
    const rec = new Record(coll, { key: "instance", poll_sync: false, service_account_key: "", key_client_email: "" });
    app.save(rec);
  }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("app_settings");
    app.delete(c);
  } catch (_) { /* gone */ }
});
