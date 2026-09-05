// =============================================================================
// gw-mailbox UI — PocketBase client + realtime (SSE over fetch stream)
//
// The SSE realtime stream needs the Authorization header, which EventSource
// cannot set — so we read the stream with fetch + ReadableStream instead.
// Flow (PB 0.39): GET /api/realtime -> PB_CONNECT {clientId} -> subscribe via
// POST /api/realtime {clientId, subscriptions:[...]}.
// =============================================================================

import { state, toast } from "./state.svelte.js";

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
  const token = opts.token ?? state.token;
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

export async function loadSession() {
  // bootstrap /me + permitted inboxes + lightweight directory
  const meRes = await pbRequest("GET", "/mailbox/me");
  state.me = meRes.me;
  state.inboxes = meRes.inboxes || [];
  if (state.inboxes.length) {
    state.activeInboxId =
      state.inboxes.find((i) => i.id === state.activeInboxId)?.id || state.inboxes[0].id;
  }
  await refreshThreads();
}

export async function refreshThreads() {
  const filter = encodeURIComponent('inbox = "' + state.activeInboxId + '"');
  const res = await pbRequest(
    "GET",
    `/collections/threads/records?perPage=200&sort=-last_message_at&filter=${filter}`
  );
  for (const item of res.items || []) {
    state.threads[item.id] = item;
  }
}

export async function fetchMessages(threadId) {
  const filter = encodeURIComponent(`thread = "${threadId}"`);
  const res = await pbRequest(
    "GET",
    `/collections/messages/records?perPage=200&sort=created&filter=${filter}`
  );
  state.messages[threadId] = res.items || [];
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
  return pbRequest("POST", `/mailbox/threads/${threadId}/reply`, { body });
}

export function availability(threadId, start, end, durationMin = 30) {
  const q = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&durationMin=${durationMin}`;
  return pbRequest("GET", `/mailbox/threads/${threadId}/availability?${q}`);
}

export function bookMeet(threadId, payload) {
  return pbRequest("POST", `/mailbox/threads/${threadId}/meet`, payload);
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
      delete state.threads[record.id];
    } else if (record.inbox) {
      state.threads[record.id] = { ...(state.threads[record.id] || {}), ...record };
    }
  } else if (collection === "messages") {
    const threadId = record.thread;
    if (action === "delete") {
      state.messages[threadId] = (state.messages[threadId] || []).filter((m) => m.id !== record.id);
    } else if (threadId) {
      const list = state.messages[threadId] || [];
      const i = list.findIndex((m) => m.id === record.id);
      if (i >= 0) list[i] = { ...list[i], ...record };
      else if (state.openThreadId === threadId) list.push(record);
      state.messages[threadId] = list;
    }
  } else if (collection === "thread_presence") {
    const key = `${record.thread}:${record.user}`;
    if (action === "delete") {
      delete state.presence[key];
    } else {
      const existing = state.presence[key];
      state.presence[key] = {
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
        headers: { Authorization: "Bearer " + state.token }
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
        `thread_presence/${state.openThreadId || "*"}`,
        `messages/${state.openThreadId || "*"}`
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
            state.realtimeOn = true;
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
      state.realtimeOn = false;
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
  state.realtimeOn = false;
}
