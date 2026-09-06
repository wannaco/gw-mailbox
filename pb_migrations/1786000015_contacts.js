/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — contacts
// A contact record is auto-created/updated from the email address on inbound
// mail, and linked to threads by customer_email. Agents can view + edit
// contact details (name/phone/company/notes) from the ticket.
//   email     text  req, unique — the customer address
//   name      text
//   phone     text
//   company   text
//   title     text
//   notes     text
//   tags      json  (contact tags)
//   last_seen date  — most recent inbound msg date
// =============================================================================
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("contacts");
  } catch (_) {
    coll = new Collection({
      name: "contacts",
      type: "base",
      fields: [
        { name: "email", type: "email", required: true },
        { name: "name", type: "text", max: 200 },
        { name: "phone", type: "text", max: 60 },
        { name: "company", type: "text", max: 200 },
        { name: "title", type: "text", max: 200 },
        { name: "notes", type: "text", max: 5000 },
        { name: "tags", type: "json", maxSize: 20000 },
        { name: "last_seen", type: "date" }
      ]
    });
    coll.listRule = '@request.auth.id != ""';
    coll.viewRule = '@request.auth.id != ""';
    coll.createRule = '@request.auth.id != ""';
    coll.updateRule = '@request.auth.id != ""';
    coll.deleteRule = null;
    app.save(coll);
    if (!coll.getIndex("idx_contacts_email")) {
      coll.addIndex("idx_contacts_email", true, "email");
      app.save(coll);
    }
    console.log("[gw-mailbox] contacts collection created");
  }
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("contacts");
    app.deleteCollection(c);
  } catch (_) { /* gone */ }
});
