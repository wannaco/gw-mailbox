/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — message attachments (files stored with the conversation)
// Adds to `messages`:
//   attachments       file (multiple) — the binary files
//   attachments_meta  json            — [{name, mime, size}] aligned by index
// =============================================================================
migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  if (!messages.fields.getByName("attachments")) {
    messages.fields.addMarshaledJSON(JSON.stringify([
      { name: "attachments", type: "file", maxSelect: 20, maxSize: 26214400, mimeTypes: [] }
    ]));
  }
  if (!messages.fields.getByName("attachments_meta")) {
    messages.fields.addMarshaledJSON(JSON.stringify([
      { name: "attachments_meta", type: "json", maxSize: 200000 }
    ]));
  }
  app.save(messages);
  console.log("[gw-mailbox] messages.attachments field added");
}, (app) => {
  // Downgrade: leave fields (dropping files is destructive); no-op.
});
