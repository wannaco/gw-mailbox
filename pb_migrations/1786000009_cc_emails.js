/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — per-message Cc recipients
// Adds to `messages`:
//   cc_emails  json — addresses that were Cc'd on this message (for reply-all
//                     and display). Legacy rows have none (recipient_emails
//                     holds the merged To+Cc list for those).
// =============================================================================
migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  if (!messages.fields.getByName("cc_emails")) {
    messages.fields.addMarshaledJSON(JSON.stringify([
      { name: "cc_emails", type: "json", maxSize: 200000 }
    ]));
    app.save(messages);
    console.log("[gw-mailbox] messages.cc_emails field added");
  }
}, (app) => {
  // Downgrade: leave the field (non-destructive).
});
