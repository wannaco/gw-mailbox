/// <reference path="../pb_data/types.d.ts" />
// =============================================================================
// gw-mailbox — store each message's RFC Message-ID header
// So outgoing replies / nudges can carry In-Reply-To + References and thread
// correctly in the customer's mailbox (Gmail threads by those headers, not
// just by the API threadId — without them a nudge lands as a NEW email).
// =============================================================================
migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  if (!messages.fields.getByName("gmail_msgid_header")) {
    messages.fields.addMarshaledJSON(JSON.stringify([
      { name: "gmail_msgid_header", type: "text", max: 500 }
    ]));
    app.save(messages);
    console.log("[gw-mailbox] messages.gmail_msgid_header field added");
  }
}, (app) => {
  // Downgrade: leave the field (non-destructive).
});
