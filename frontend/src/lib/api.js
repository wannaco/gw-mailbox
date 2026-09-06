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
}

export async function loadSession() {
  // bootstrap /me + permitted inboxes + lightweight directory
  const meRes = await pbRequest("GET", "/mailbox/me");
  loadReadCounts();
  appState.me = meRes.me;
  appState.inboxes = meRes.inboxes || [];
  if (appState.inboxes.length) {
    appState.activeInboxId =
      appState.inboxes.find((i) => i.id === appState.activeInboxId)?.id || appState.inboxes[0].id;
  }
  await refreshThreads();
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

// ---- presence / notes / moves / replies / meet -----------------------------

export function heartbeat(threadId, status) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/presence`, { status });
}

export function releasePresence(threadId) {
  return pbRequest("DELETE", `/mailbox/threads/${threadId}/presence`);
}

export function addNote(threadId, body) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/notes`, { body });
}

export function moveThread(threadId, status, extra = {}) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/move`, { status, ...extra });
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
      appState.presence[key] = {
        ...(existing || {}),
        thread: record.thread,
        user: record.user,
        status: record.status,
        updatedAt: record.updated_at,
        agentName: existing?.agentName || ""
      };
    }
  }
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
