/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — follow-up / auto-close automation state + config
// Adds to `threads` (per-ticket follow-up state):
//   followup_sent     number — how many follow-up nudges have been sent
//   followup_next_at  date   — when the next follow-up (or auto-close) is due
//   followup_last_at  date   — when the last follow-up was sent
// Adds to `app_settings` (configurable from Settings -> Ticket automations):
//   followup_enabled     bool   — master switch
//   followup_delay_h     number — wait (hours) in waiting_customer before 1st nudge
//   followup_interval_h  number — hours between nudges
//   followup_max         number — nudges before auto-close
//   autoclose_enabled    bool   — auto-close after max nudges w/o reply
//   followup_subject     text   — optional custom subject ({subject} placeholder)
//   followup_body        text   — nudge body template
// =============================================================================
migrate((app) => {
  // threads
  const threads = app.findCollectionByNameOrId("threads");
  const ensureField = (coll, f) => { if (!coll.fields.getByName(f.name)) coll.fields.addMarshaledJSON(JSON.stringify([f])); };
  ensureField(threads, { name: "followup_sent", type: "number", min: 0, onlyInt: true });
  ensureField(threads, { name: "followup_next_at", type: "date" });
  ensureField(threads, { name: "followup_last_at", type: "date" });
  app.save(threads);

  // app_settings
  const as = app.findCollectionByNameOrId("app_settings");
  ensureField(as, { name: "followup_enabled", type: "bool" });
  ensureField(as, { name: "followup_delay_h", type: "number", min: 0 });
  ensureField(as, { name: "followup_interval_h", type: "number", min: 0 });
  ensureField(as, { name: "followup_max", type: "number", min: 1, onlyInt: true });
  ensureField(as, { name: "autoclose_enabled", type: "bool" });
  ensureField(as, { name: "followup_subject", type: "text", max: 300 });
  ensureField(as, { name: "followup_body", type: "text", max: 12000 });
  app.save(as);
  console.log("[gw-mailbox] follow-up automation fields added (threads + app_settings)");
}, (app) => {
  // Downgrade: leave fields (non-destructive).
});
