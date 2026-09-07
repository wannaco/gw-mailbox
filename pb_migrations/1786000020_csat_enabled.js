/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — CSAT enable switch
// Adds app_settings.csat_enabled (bool). CSAT auto-surveys on ticket close are
// OFF by default — a client must opt in from Settings → CSAT before the engine
// emails any customer a survey link. New bool fields default false on existing
// rows, which is exactly the desired default here.
// =============================================================================
migrate((app) => {
  const as = app.findCollectionByNameOrId("app_settings");
  if (!as.fields.getByName("csat_enabled")) {
    as.fields.addMarshaledJSON(JSON.stringify([{ name: "csat_enabled", type: "bool" }]));
    app.save(as);
    console.log("[gw-mailbox] app_settings.csat_enabled added (default off)");
  } else {
    console.log("[gw-mailbox] app_settings.csat_enabled already exists");
  }
}, (app) => {
  // Downgrade: leave field (non-destructive).
});
