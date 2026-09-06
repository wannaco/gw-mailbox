/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — label/category catalog
// Managed categories (beyond the kanban statuses) that can be tagged onto
// threads (stored in threads.tags). Colors let the UI render consistent chips.
//   name   text unique  — label text (e.g. "Billing", "VIP", "Urgent")
//   color  text         — hex/hue token for the chip
// Agents can READ the catalog (to tag threads) and CREATE new labels on the
// fly; only server (superuser) endpoints may rename/delete.
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("labels");
  } catch (_) {
    coll = new Collection({
      name: "labels",
      type: "base",
      fields: [
        { name: "name", type: "text", required: true, max: 80 },
        { name: "color", type: "text", max: 20 }
      ]
    });
    coll.listRule = '@request.auth.id != ""';
    coll.viewRule = '@request.auth.id != ""';
    coll.createRule = '@request.auth.id != ""';
    coll.updateRule = null;
    coll.deleteRule = null;
    app.save(coll);
    if (!coll.getIndex("idx_labels_name")) {
      coll.addIndex("idx_labels_name", true, "name");
      app.save(coll);
    }
    console.log("[gw-mailbox] labels collection created");
  }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("labels");
    app.deleteCollection(c);
  } catch (_) { /* gone */ }
});
