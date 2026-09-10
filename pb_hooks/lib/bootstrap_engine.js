// =============================================================================
// gw-mailbox — deployment bootstrap (engine)
//
// Env-driven, idempotent host bootstrap so a fresh install works on ANY domain
// with zero manual clicking:
//
//   MAILBOX_PUBLIC_URL        -> PocketBase meta.appURL + app_settings.public_url
//                                (required for OAuth2 redirect validation, CSAT
//                                survey links and any absolute URL we emit)
//   MAILBOX_ADMIN_EMAIL       -> create the first superuser if missing
//   MAILBOX_ADMIN_PASSWORD
//
// Only writes when a value actually differs, so it is safe to run on every boot
// and on existing installs (nothing is ever overwritten with a guess).
//
// Invoked per-minute by the gw-bootstrap cron (see zz_bootstrap.pb.js) so the
// DB/settings are fully initialised — touching them during onBootstrap panics.
// Every write is guarded and only happens when a value actually differs, so
// repeated runs are no-ops (and it self-heals if env changes later).
// =============================================================================

var bsh = require(__hooks + "/lib/helpers.js");

function runBootstrap() {
  try {
    const publicUrl = ($os.getenv("MAILBOX_PUBLIC_URL") || "").trim().replace(/\/+$/, "");

    if (publicUrl) {
      // 1) PocketBase app URL. WITHOUT this a fresh install keeps the default
      //    http://localhost:8090, which breaks OAuth2 redirect validation and
      //    every generated absolute link.
      try {
        const s = $app.settings();
        if (s && s.meta && s.meta.appURL !== publicUrl) {
          s.meta.appURL = publicUrl;
          $app.save(s);
          bsh.log("bootstrap: appURL ->", publicUrl);
        }
      } catch (err) {
        bsh.warn("bootstrap: appURL update skipped:", (err && err.message) || err);
      }

      // 2) app_settings.public_url — the base our emails/links use.
      try {
        const rec = $app.findFirstRecordByFilter("app_settings", "key = 'instance'");
        if (rec && String(rec.getString("public_url") || "") !== publicUrl) {
          rec.set("public_url", publicUrl);
          $app.save(rec);
          bsh.log("bootstrap: app_settings.public_url ->", publicUrl);
        }
      } catch (_) { /* collection may not exist yet on the very first boot */ }
    }

    // 3) First superuser (idempotent — never touches an existing account).
    const email = ($os.getenv("MAILBOX_ADMIN_EMAIL") || "").trim();
    const password = $os.getenv("MAILBOX_ADMIN_PASSWORD") || "";
    if (email && password) {
      let exists = true;
      try {
        $app.findAuthRecordByEmail("_superusers", email);
      } catch (_) {
        exists = false;
      }
      if (!exists) {
        try {
          const coll = $app.findCollectionByNameOrId("_superusers");
          const su = new Record(coll, { email: email, verified: true });
          su.setPassword(password);
          $app.save(su);
          bsh.log("bootstrap: created superuser", email);
        } catch (err) {
          bsh.warn("bootstrap: superuser create failed:", (err && err.message) || err);
        }
      }
    }
  } catch (err) {
    bsh.warn("bootstrap warning:", (err && err.message) || err);
  }
}

module.exports = { runBootstrap };
