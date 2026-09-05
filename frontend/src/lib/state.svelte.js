// =============================================================================
// gw-mailbox UI — global state (Svelte 5 runes, module singleton)
// =============================================================================

export const STATUSES = [
  { value: "new", label: "New", dot: "#0b57d0" },
  { value: "in_progress", label: "In progress", dot: "#f9ab00" },
  { value: "waiting_customer", label: "Waiting on customer", dot: "#9334e6" },
  { value: "escalated", label: "Escalated", dot: "#ba1a1a" },
  { value: "closed", label: "Closed", dot: "#5f6368" }
];

export const state = $state({
  pbUrl: "", // relative -> vite dev proxy to PocketBase
  token: "",
  me: null, // { id, name, email, googleEmail }
  users: {}, // id -> { name, email } (directory cache for presence/assignee)
  inboxes: [],
  activeInboxId: "",
  search: "",
  onlyMine: false,
  threads: {}, // threadId -> thread record (all permitted inboxes)
  messages: {}, // threadId -> message records
  openThreadId: "",
  presence: {}, // `${threadId}:${userId}` -> { thread, user, status, agentName, updatedAt }
  composerState: "idle", // idle | composing (this client)
  realtimeOn: false,
  toasts: [] // { id, kind: info|error|success, message }
});

let toastSeq = 0;
export function toast(kind, message) {
  toastSeq += 1;
  const id = toastSeq;
  state.toasts.push({ id, kind, message });
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, 4200);
}

export function statusMeta(value) {
  return STATUSES.find((s) => s.value === value) || STATUSES[0];
}

export function threadsOfActiveInbox() {
  const tid = state.activeInboxId;
  return Object.values(state.threads).filter((t) => t.inbox === tid);
}

export function presenceFor(threadId) {
  const out = [];
  for (const [k, p] of Object.entries(state.presence)) {
    if (p.thread === threadId && p.status !== "closed") out.push(p);
  }
  return out;
}

// True when ANY OTHER agent is composing this thread (draft lock).
export function composingLock(threadId) {
  const me = state.me?.id;
  return presenceFor(threadId).find((p) => p.user !== me && p.status === "composing_reply") || null;
}

export function userName(id) {
  return state.users[id]?.name || state.users[id]?.email || "Another agent";
}

export function agentInitials(nameOrEmail) {
  const s = String(nameOrEmail || "?");
  if (s.includes(" ")) {
    return s.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
  }
  return s.slice(0, 2).toUpperCase();
}

export function resetSession() {
  state.token = "";
  state.me = null;
  state.users = {};
  state.inboxes = [];
  state.threads = {};
  state.messages = {};
  state.presence = {};
  state.openThreadId = "";
  state.activeInboxId = "";
  state.realtimeOn = false;
}
