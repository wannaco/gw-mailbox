// =============================================================================
// gw-mailbox UI — URL <-> view state
//
// The app had no router: sections were switched by assigning reactive state, so
// the URL never changed. A refresh therefore dropped you back on the default
// inbox list, and no view was linkable.
//
// This is deliberately NOT a general-purpose router. There are only four shapes:
//
//   /                        list view, default inbox
//   /inbox/<inboxId>         list view, that inbox
//   /inbox/<inboxId>/thread/<threadId>   that thread open in the drawer
//   /settings | /reports | /profile | /board
//
// Board is a top-level path rather than nested under the inbox: the view toggle
// is a topbar control, not a property of one mailbox, and "/board" is the URL a
// person would actually type or bookmark.
//
// Reserved by the app and never produced here: /csat/<token>, /notices,
// /auth/callback. Those are parsed before this module runs and are public pages.
// =============================================================================

const SECTION_SCREENS = ["settings", "reports", "profile"];

/**
 * Parse a pathname into view state.
 * Always returns a full shape so callers can apply it wholesale without having
 * to know which parts were present.
 */
export function parsePath(pathname) {
  const clean = String(pathname || "/").replace(/\/+$/, "") || "/";

  if (clean === "/board") {
    return { screen: "mail", view: "board", activeInboxId: "", openThreadId: "" };
  }

  const section = clean.replace(/^\//, "");
  if (SECTION_SCREENS.indexOf(section) !== -1) {
    return { screen: section, view: "list", activeInboxId: "", openThreadId: "" };
  }

  const thread = clean.match(/^\/inbox\/([^/]+)\/thread\/([^/]+)$/);
  if (thread) {
    return { screen: "mail", view: "list", activeInboxId: thread[1], openThreadId: thread[2] };
  }

  const inbox = clean.match(/^\/inbox\/([^/]+)$/);
  if (inbox) {
    return { screen: "mail", view: "list", activeInboxId: inbox[1], openThreadId: "" };
  }

  // "/" and anything unrecognised fall back to the default inbox list. Unknown
  // paths are not an error state — the app is served for any path, so a stray
  // link should simply land somewhere sensible.
  return { screen: "mail", view: "list", activeInboxId: "", openThreadId: "" };
}

/**
 * Build the canonical URL for the given view state.
 * `defaultInboxId` keeps the root path clean: the app's own default inbox is
 * "/", not "/inbox/<id>", so a plain refresh does not bake an id into the URL.
 */
export function buildPath({ screen, view, activeInboxId, openThreadId }, defaultInboxId) {
  if (screen && screen !== "mail") return `/${screen}`;
  if (view === "board") return "/board";

  const id = activeInboxId || "";
  if (id && id !== defaultInboxId) {
    if (openThreadId) return `/inbox/${id}/thread/${openThreadId}`;
    return `/inbox/${id}`;
  }
  // Default inbox: no inbox segment. A specific thread still needs the id.
  if (openThreadId && id) return `/inbox/${id}/thread/${openThreadId}`;
  return "/";
}

/** True when the current path is a public page the app handles separately. */
export function isPublicPath(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "") || "/";
  return p === "/notices" || p === "/auth/callback" || /^\/csat\/[A-Za-z0-9_-]+$/.test(p);
}
