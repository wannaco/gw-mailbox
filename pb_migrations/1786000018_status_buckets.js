/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — extend threads.status select with cleanup buckets
// Bulk cleanup (search → multi-select → mark spam / archive / close / delete)
// needs two new STATUS values beyond the kanban workflow: `spam` and
// `archived`. threads.status is a DB select field, so simply adding them to the
// JS constant isn't enough — the field's allowed values must be extended here
// or PB rejects the write ("Invalid value spam."). Existing rows are untouched.
// =============================================================================
migrate((app) => {
  const coll = app.findCollectionByNameOrId("threads");
  const f = coll.fields.getByName("status");
  if (f && Array.isArray(f.values)) {
    const have = new Set(f.values);
    let changed = false;
    for (const v of ["spam", "archived"]) {
      if (!have.has(v)) { f.values.push(v); changed = true; }
    }
    if (changed) {
      app.save(coll);
      console.log("[gw-mailbox] threads.status values extended (spam, archived)");
    } else {
      console.log("[gw-mailbox] threads.status already has spam/archived");
    }
  } else {
    console.log("[gw-mailbox] threads.status field not found or not a select — skip");
  }
}, (app) => {
  // Downgrade: leave values (non-destructive).
});
