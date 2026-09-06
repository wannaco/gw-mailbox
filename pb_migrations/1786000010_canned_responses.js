/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — canned responses (slash commands in the compose box)
// Agents insert these via "/" in the reply editor. Everyone on the team reads
// + creates (like labels); deletion is admin-only via a settings route.
//   title  text req — command name shown after "/" (e.g. "hours")
//   body   text req — the response text inserted into the editor
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("canned_responses");
  } catch (_) {
    coll = new Collection({
      name: "canned_responses",
      type: "base",
      fields: [
        { name: "title", type: "text", required: true, max: 120 },
        { name: "body", type: "text", required: true, max: 12000 }
      ]
    });
    coll.listRule = '@request.auth.id != ""';
    coll.viewRule = '@request.auth.id != ""';
    coll.createRule = '@request.auth.id != ""';
    coll.updateRule = null;
    coll.deleteRule = null;
    app.save(coll);
    if (!coll.getIndex("idx_canned_title")) {
      coll.addIndex("idx_canned_title", false, "title");
      app.save(coll);
    }
    console.log("[gw-mailbox] canned_responses collection created");
  }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("canned_responses");
    app.deleteCollection(c);
  } catch (_) { /* gone */ }
});
