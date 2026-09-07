// =============================================================================
// gw-mailbox UI — PocketBase client + realtime (SSE over fetch stream)
//
// The SSE realtime stream needs the Authorization header, which EventSource
// cannot set — so we read the stream with fetch + ReadableStream instead.
// Flow (PB 0.39): GET /api/realtime -> PB_CONNECT {clientId} -> subscribe via
// POST /api/realtime {clientId, subscriptions:[...]}.
// =============================================================================

import { appState, toast, loadReadCounts } from "./appState.svelte.js";

export const PB_URL = (import.meta.env.VITE_PB_URL || "").replace(/\/$/, "");

function url(path) {
  return PB_URL + "/api" + path;
}

const TOKEN_KEY = "gwmb.token";

export function savedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export async function pbRequest(method, path, body, opts = {}) {
  const token = opts.token ?? appState.token;
  const res = await fetch(url(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 401 && !opts.allow401) {
    throw new AuthError(data?.message || "Session expired");
  }
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export class AuthError extends Error {}

// OAuth2 (Google) — PB 0.39 code flow. auth-methods returns the google provider
// with a ready authUrl (incl. PKCE challenge) + codeVerifier when the users
// collection has OAuth2 enabled + a google provider configured. Exchange the
// returned code at /auth-with-oauth2 for a { token, record }.
export async function checkOAuthProviders() {
  const origin = window.location.origin;
  const res = await pbRequest(
    "GET",
    `/collections/users/auth-methods?redirectUrl=${encodeURIComponent(origin)}`,
    undefined,
    { token: "" }
  );
  const provs = (res && res.oauth2 && res.oauth2.providers) || [];
  return {
    enabled: !!(res && res.oauth2 && res.oauth2.enabled),
    providers: provs,
    google: provs.find((p) => String(p.name || "").toLowerCase() === "google") || null
  };
}

export function oauthExchange(provider, code, codeVerifier, redirectURL) {
  return pbRequest("POST", `/collections/users/auth-with-oauth2`, {
    provider,
    code,
    codeVerifier,
    redirectURL
  });
}

export function authWithPassword(email, password) {
  return pbRequest(
    "POST",
    "/collections/users/auth-with-password",
    { identity: email, password },
    { token: "" }
  );
}

// PocketBase admin (superuser) sign-in — grants Settings access.
export function adminAuth(email, password) {
  return pbRequest(
    "POST",
    "/collections/_superusers/auth-with-password",
    { identity: email, password },
    { token: "" }
  );
}

export async function adminSession() {
  const meRes = await pbRequest("GET", "/mailbox/me");
  loadReadCounts();
  appState.me = meRes.me; // superuser: isSuperuser true
  appState.inboxes = meRes.inboxes || [];
  if (meRes.sla) appState.slaConfig = { enabled: !!meRes.sla.sla_enabled, hours: Number(meRes.sla.sla_hours) || 24 };
  if (appState.inboxes.length) {
    appState.activeInboxId =
      appState.inboxes.find((i) => i.id === appState.activeInboxId)?.id || appState.inboxes[0].id;
  }
  await refreshThreads();
  loadDirectory();
  loadNotifications();
  ensureNotifications();
}

export async function loadSession() {
  // bootstrap /me + permitted inboxes + lightweight directory
  const meRes = await pbRequest("GET", "/mailbox/me");
  loadReadCounts();
  appState.me = meRes.me;
  appState.inboxes = meRes.inboxes || [];
  if (meRes.sla) appState.slaConfig = { enabled: !!meRes.sla.sla_enabled, hours: Number(meRes.sla.sla_hours) || 24 };
  if (appState.inboxes.length) {
    appState.activeInboxId =
      appState.inboxes.find((i) => i.id === appState.activeInboxId)?.id || appState.inboxes[0].id;
  }
  await refreshThreads();
  loadDirectory();
  loadNotifications();
  ensureNotifications();
}

export async function refreshThreads() {
  const filter = encodeURIComponent('inbox = "' + appState.activeInboxId + '"');
  const res = await pbRequest(
    "GET",
    `/collections/threads/records?perPage=200&sort=-last_message_at&filter=${filter}`
  );
  for (const item of res.items || []) {
    appState.threads[item.id] = item;
  }
}

export async function fetchMessages(threadId) {
  const filter = encodeURIComponent(`thread = "${threadId}"`);
  // NOTE: this PB fork has no created/updated system fields — server-side
  // sort=created returns 400. Fetch all and order by msg_date client-side.
  const res = await pbRequest(
    "GET",
    `/collections/messages/records?perPage=200&filter=${filter}`
  );
  const items = (res.items || []).slice().sort((a, b) =>
    String(a.msg_date || "").localeCompare(String(b.msg_date || ""))
  );
  appState.messages[threadId] = items;
}

// Team directory (id -> { id, name, email }) for @mentions + assignee names.
export async function loadDirectory() {
  try {
    const res = await pbRequest("GET", "/mailbox/users");
    const map = {};
    for (const u of res.users || []) map[u.id] = { id: u.id, name: u.name, email: u.email, kind: u.kind || 'agent', signature: u.signature || '', signature_auto: !!u.signature_auto };
    appState.users = map;
  } catch {
    /* non-fatal */
  }
}

// ---- presence / notes / moves / replies / meet -----------------------------

export function heartbeat(threadId, status) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/presence`, { status });
}

export function releasePresence(threadId) {
  return pbRequest("DELETE", `/mailbox/threads/${threadId}/presence`);
}

export function addNote(threadId, body) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/notes`, body);
}

export function moveThread(threadId, status, extra = {}) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/move`, { status, ...extra });
}

export function bulkThreads(ids, action) {
  return pbRequest("POST", "/mailbox/threads/bulk", { ids, action });
}

export function sendReply(threadId, body) {
  // Send the payload AS the request body — the server expects
  // { body, html, attachments } at the top level, not nested under "body".
  return pbRequest("POST", `/mailbox/threads/${threadId}/reply`, body);
}

export function availability(threadId, start, end, durationMin = 30) {
  const q = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&durationMin=${durationMin}`;
  return pbRequest("GET", `/mailbox/threads/${threadId}/availability?${q}`);
}

export function bookMeet(threadId, payload) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/meet`, payload);
}
export function cancelMeet(threadId) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/cancel-meet`);
}


// ---- admin settings -----------------------------------------------------
export function getSettings() {
  return pbRequest("GET", "/mailbox/settings");
}
export function saveServiceAccount(serviceAccountJson) {
  return pbRequest("POST", "/mailbox/settings/service-account", { serviceAccountJson });
}
export function removeServiceAccount() {
  return pbRequest("DELETE", "/mailbox/settings/service-account");
}
export function testConnection(subject, serviceAccountJson) {
  return pbRequest("POST", "/mailbox/settings/test-connection", {
    subject,
    ...(serviceAccountJson ? { serviceAccountJson } : {})
  });
}
export function setPollSync(enabled) {
  return pbRequest("POST", "/mailbox/settings/sync-mode", { enabled });
}
export function saveMentionAdmins(ids) {
  return pbRequest("POST", "/mailbox/settings/mention-admins", { ids });
}

// ---- ticket automations (follow-up / auto-close) ----------------------------
export async function getAutomations() {
  return pbRequest("GET", "/mailbox/settings/automations");
}
export function saveAutomations(cfg) {
  return pbRequest("POST", "/mailbox/settings/automations", { automation: cfg });
}

// ---- SLA config (admin settings; chips read it via /me) ---------------------
export function saveSla(cfg) {
  return pbRequest("POST", "/mailbox/settings/sla", cfg);
}

// ---- CSAT enable (admin settings; dispatch on close when on) -----------------
export function saveCsat(enabled) {
  return pbRequest("POST", "/mailbox/settings/csat", { csat_enabled: enabled });
}

// ---- reports ---------------------------------------------------------------
export function getReports() {
  return pbRequest("GET", "/mailbox/reports");
}

// ---- agent signatures ------------------------------------------------------
export function saveMySignature({ signature, signature_auto }) {
  return pbRequest("POST", "/mailbox/me/signature", { signature, signature_auto });
}
export function adminSaveAgentSignature(id, { signature, signature_auto }) {
  return pbRequest("POST", `/mailbox/settings/users/${id}/signature`, { signature, signature_auto });
}

// ---- mailboxes (admin settings) --------------------------------------------
export function listMailboxes() {
  return pbRequest("GET", "/mailbox/settings/inboxes");
}
export function createMailbox(payload) {
  return pbRequest("POST", "/mailbox/settings/inboxes", payload);
}
export function updateMailbox(id, payload) {
  return pbRequest("POST", `/mailbox/settings/inboxes/${id}`, payload);
}
export function deleteMailbox(id) {
  return pbRequest("DELETE", `/mailbox/settings/inboxes/${id}`);
}

// ---- labels / categories ----------------------------------------------------
export function listLabels() {
  // agents + admins may read the catalog (listRule any-auth)
  return pbRequest("GET", "/collections/labels/records?perPage=200");
}
export function createLabelRecord(payload) {
  // agents may add labels on the fly (createRule any-auth)
  return pbRequest("POST", "/collections/labels/records", payload);
}
export function deleteLabelRecord(id) {
  // admin-only (settings route, superuser)
  return pbRequest("DELETE", `/mailbox/settings/labels/${id}`);
}

// ---- contacts -----------------------------------------------------------------
export async function getContact(email, related, inboxId) {
  let p = `/mailbox/contacts?email=${encodeURIComponent(email || "")}`;
  if (related) p += "&related=1";
  if (inboxId) p += `&inbox=${encodeURIComponent(inboxId)}`;
  return pbRequest("GET", p);
}
export function saveContact(payload) {
  return pbRequest("POST", "/mailbox/contacts/save", payload);
}

// ---- canned responses (slash commands) --------------------------------------
export function listCanned() {
  return pbRequest("GET", "/collections/canned_responses/records?perPage=200");
}
export function createCannedRecord(payload) {
  return pbRequest("POST", "/collections/canned_responses/records", payload);
}
export function deleteCannedRecord(id) {
  return pbRequest("DELETE", `/mailbox/settings/canned/${id}`);
}

// ---- notifications (mentions / notes) ---------------------------------------
export async function loadNotifications() {
  try {
    const res = await pbRequest("GET", "/mailbox/notifications");
    appState.notifications = res.notifications || [];
    return appState.notifications;
  } catch {
    return appState.notifications || [];
  }
}
export function markNotifRead(id) {
  return pbRequest("POST", `/mailbox/notifications/${id}/read`, {});
}
export function markAllNotifsRead() {
  return pbRequest("POST", "/mailbox/notifications/read-all", {});
}

// ---- realtime --------------------------------------------------------------

let rtActive = false;
let rtAbort = null;

function upsertRecord(collection, data) {
  const record = data.record || data;
  const action = data.action || (data.record ? "update" : "create");
  if (!record?.id) return;

  if (collection === "threads") {
    if (action === "delete") {
      delete appState.threads[record.id];
    } else if (record.inbox) {
      appState.threads[record.id] = { ...(appState.threads[record.id] || {}), ...record };
    }
  } else if (collection === "messages") {
    const threadId = record.thread;
    if (action === "delete") {
      appState.messages[threadId] = (appState.messages[threadId] || []).filter((m) => m.id !== record.id);
    } else if (threadId) {
      const list = appState.messages[threadId] || [];
      const i = list.findIndex((m) => m.id === record.id);
      if (i >= 0) list[i] = { ...list[i], ...record };
      else if (appState.openThreadId === threadId) list.push(record);
      appState.messages[threadId] = list;
    }
  } else if (collection === "thread_presence") {
    const key = `${record.thread}:${record.user}`;
    if (action === "delete") {
      delete appState.presence[key];
    } else {
      const existing = appState.presence[key];
      const dir = appState.users[record.user];
      const nm = dir?.name || existing?.agentName || "";
      appState.presence[key] = {
        ...(existing || {}),
        thread: record.thread,
        user: record.user,
        status: record.status,
        updatedAt: record.updated_at,
        agentName: nm
      };
    }
  } else if (collection === "agent_presence") {
    scheduleRosterRefresh();
  } else if (collection === "notifications") {
    // A notification that concerns me was created/updated -> refresh list.
    // If it's new + unread and the tab is hidden/backgrounded, fire an OS
    // notification (requires permission, requested on first mention).
    const rec = data.record || data;
    if (rec && rec.read === false && !document.hasFocus()) {
      const kind = rec.kind === "mention" ? "mentioned you" : rec.kind === "assigned" ? "assigned a ticket" : "added a note";
      const who = rec.actor_name || "Someone";
      const subj = rec.thread_subject || "a thread";
      const body = rec.body_snippet || "";
      notifyNative(`${who} ${kind}`, `${subj}${body ? " — " + body : ""}`);
    }
    loadNotifications();
  }
}

// Native browser notification (graceful: request permission once, silently skip
// if denied/unsupported). Clicking it focuses the app + opens the thread.
let notifPermAsked = false;
function notifyNative(title, body) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default" && !notifPermAsked) {
      notifPermAsked = true;
      Notification.requestPermission().then((p) => {
        if (p === "granted") notifyNative(title, body);
      });
      return;
    }
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag: "gwmb-" + title, icon: "/favicon.ico" });
    n.onclick = () => {
      window.focus();
      try { n.close(); } catch (_) {}
    };
  } catch (_) { /* ignore */ }
}

function parseSseFrame(raw) {
  const lines = String(raw).split(/\r?\n/);
  let event = "";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

async function rtLoop() {
  while (rtActive) {
    try {
      const res = await fetch(url("/realtime"), {
        headers: { Authorization: "Bearer " + appState.token }
      });
      if (!res.ok || !res.body) throw new Error("realtime " + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let clientId = "";

      // Subscriptions are (re)established after every (re)connect.
      const subscriptions = [
        "threads",
        "messages",
        "thread_presence",
        "agent_presence",
        "notifications",
        `thread_presence/${appState.openThreadId || "*"}`,
        `messages/${appState.openThreadId || "*"}`
      ];

      while (rtActive) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frameText = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parseSseFrame(frameText);
          if (!frame) continue;

          if (frame.event === "PB_CONNECT") {
            clientId = frame.data?.clientId || "";
            appState.realtimeOn = true;
            // Subscribe for this client.
            try {
              await pbRequest("POST", "/realtime", {
                clientId,
                subscriptions: [...new Set(subscriptions)]
              });
            } catch {
              /* reconnect cycle will retry */
            }
            continue;
          }
          if (frame.event === "PB_PING") continue;

          // event name: either "<collection>/<action>" or "<collection>"
          const slash = frame.event.indexOf("/");
          let collection = frame.event;
          if (slash !== -1) collection = frame.event.slice(0, slash);
          upsertRecord(collection, frame.data);
        }
      }
    } catch (err) {
      if (rtActive && !String(err.message).includes("session")) {
        // silent retry — transient disconnects are normal
      }
    }
    if (rtActive) {
      appState.realtimeOn = false;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

// Ask for browser notification permission once (browsers need a prompt; we fire
// it right after login so it's visible). Returns true when granted.
export function ensureNotifications() {
  try {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    // 'default' -> ask
    Notification.requestPermission();
    return false;
  } catch (_) { return false; }
}

// ---- app-wide presence loop (roster) --------------------------------------
let rosterTimer = null;
let rosterRefreshPending = false;
let rosterRefreshT = null;

// Send my heartbeat: { thread, status } — status = online (no thread) |
// viewing | composing_reply. Fired every ~8s while the app is visible and
// immediately on activity changes.
export async function beatPresence() {
  const act = appState.myActivity || { thread: "", status: "online" };
  try {
    await pbRequest("POST", "/mailbox/presence/beat", {
      thread: act.thread || "",
      status: act.status || (act.thread ? "viewing" : "online")
    });
  } catch {
    /* transient — next tick retries */
  }
}

export async function offlinePresence() {
  try {
    await pbRequest("POST", "/mailbox/presence/offline", {});
  } catch {
    /* ignore */
  }
}

export async function fetchRoster() {
  try {
    const res = await pbRequest("GET", "/mailbox/presence/roster");
    appState.roster = res.roster || [];
  } catch {
    /* non-fatal */
  }
}

function scheduleRosterRefresh() {
  if (rosterRefreshPending) return;
  rosterRefreshPending = true;
  rosterRefreshT = setTimeout(() => {
    rosterRefreshPending = false;
    fetchRoster();
  }, 400);
}

// ---- quiet periodic thread-list sync ---------------------------------------
// PB native realtime only broadcasts record changes made through the STANDARD
// collection API. Our custom routes (/move, /threads/bulk) save via pb_hooks,
// so status/archive/spam/close changes never reach OTHER open sessions — each
// one shows a stale list until a manual page reload. Fix: piggyback a quiet
// refreshThreads() on the existing presence tick (~every 10s while visible), so
// every session converges on its own within a few seconds. Cheap (one filtered
// GET of the active inbox) and guarantees correctness across users/views.
let lastThreadSync = 0;
let threadSyncInFlight = false;
const THREAD_SYNC_MS = 10000;

async function syncThreadsQuiet() {
  if (threadSyncInFlight) return;
  if (!appState.activeInboxId || document.hidden) return;
  threadSyncInFlight = true;
  try {
    await refreshThreads();
  } catch {
    /* silent — next tick retries */
  } finally {
    threadSyncInFlight = false;
  }
}

function visChange() {
  // A hidden tab is NOT logged out — switching windows should keep you online.
  if (!document.hidden) {
    beatPresence();
    fetchRoster();
    // Refresh threads right away on focus — catches edits other users made
    // while this tab was backgrounded (no waiting for the next tick).
    lastThreadSync = 0;
    syncThreadsQuiet();
  }
}

let lastBeat = 0;
const BEAT_MS = 8000;
const ROSTER_MS = 8000;

export function startPresenceLoop() {
  if (rosterTimer) return;
  beatPresence();
  fetchRoster();
  lastBeat = Date.now();
  lastThreadSync = Date.now();
  // Self-rescheduling timeout — unlike setInterval this still fires (albeit
  // throttled) in background tabs, so presence doesn't die when the tab is
  // hidden. We also refresh the roster each cycle to keep the pill live, and
  // quietly re-sync the thread list every ~10s so status/archive changes made
  // by OTHER users show up without a manual page reload.
  const tick = () => {
    const now = Date.now();
    // always keep our presence row fresh (browsers throttle timers in hidden
    // tabs to ~1/min at worst — fine, still under the 25s expiry? no: 60s > 25s,
    // so force a beat via a longer expiry instead). See below.
    if (now - lastBeat >= BEAT_MS) {
      lastBeat = now;
      beatPresence();
      fetchRoster();
    }
    if (now - lastThreadSync >= THREAD_SYNC_MS) {
      lastThreadSync = now;
      syncThreadsQuiet();
    }
    rosterTimer = setTimeout(tick, 2000);
  };
  rosterTimer = setTimeout(tick, 2000);
  document.addEventListener("visibilitychange", visChange);
  window.addEventListener("beforeunload", onBeforeUnload);
}

function onBeforeUnload() {
  offlinePresence();
}

export function stopPresenceLoop() {
  if (rosterTimer) {
    clearTimeout(rosterTimer);
    rosterTimer = null;
  }
  document.removeEventListener("visibilitychange", visChange);
  if (rosterRefreshT) {
    clearTimeout(rosterRefreshT);
    rosterRefreshT = null;
  }
  rosterRefreshPending = false;
  offlinePresence();
  appState.roster = [];
}

export function startRealtime() {
  if (rtActive) return;
  rtActive = true;
  rtAbort = { closed: false };
  rtLoop();
}

export function stopRealtime() {
  rtActive = false;
  appState.realtimeOn = false;
}
