/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — SLA config (Settings -> SLA & escalation)
// Adds to `app_settings` (configurable from Settings):
//   sla_enabled  bool   — master switch: on = new tickets get sla_due_at and
//                         the hourly monitor escalates breaches (current behavior)
//   sla_hours    number — first-response SLA window (hours) for NEW tickets
// =============================================================================
migrate((app) => {
  const as = app.findCollectionByNameOrId("app_settings");
  const ensureField = (coll, f) => { if (!coll.fields.getByName(f.name)) coll.fields.addMarshaledJSON(JSON.stringify([f])); };
  ensureField(as, { name: "sla_enabled", type: "bool" });
  ensureField(as, { name: "sla_hours", type: "number", min: 1, max: 8760, onlyInt: true });
  app.save(as);
  // Backfill the singleton so existing installs keep their historical behavior
  // (SLA tracking on, 24h). New bool fields default to false on existing rows.
  try {
    const rec = app.findFirstRecordByFilter("app_settings", "key = 'instance'");
    if (rec) {
      rec.set("sla_enabled", true);
      const v = rec.get("sla_hours");
      const n = (v === undefined || v === null || v === "") ? 24 : Number(v);
      rec.set("sla_hours", !isNaN(n) && n > 0 ? n : 24);
      app.save(rec);
    }
  } catch (_) { /* no singleton row yet */ }
  console.log("[gw-mailbox] SLA config fields added (app_settings.sla_enabled / sla_hours)");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
