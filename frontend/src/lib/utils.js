// =============================================================================
// gw-mailbox UI — formatting / sanitizing utilities
// =============================================================================

export function timeAgo(pbDate) {
  if (!pbDate) return "";
  const d = new Date(String(pbDate).replace(" ", "T") + (String(pbDate).includes("Z") ? "" : "Z"));
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDateTime(pbDate) {
  if (!pbDate) return "";
  const d = new Date(String(pbDate).replace(" ", "T") + (String(pbDate).includes("Z") ? "" : "Z"));
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function isoLocalInput(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// Curated, muted avatar palette — no rainbow noise.
const AVATAR_COLORS = [
  "#1a73e8", "#188038", "#e37400", "#9334e6", "#12a4af", "#c5221f", "#5f6368"
];

export function avatarColor(seed) {
  const s = String(seed || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Light HTML sanitizer for rendering Gmail html bodies (@html needs safety).
export function sanitizeHtml(html) {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON"]);
  doc.querySelectorAll("*").forEach((el) => {
    if (allowed.has(el.tagName)) {
      el.remove();
      return;
    }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (name === "href" || name === "src") {
        if (!/^(https?:|mailto:|tel:|#)/i.test(value)) el.removeAttribute(attr.name);
      } else if (!["href", "src", "alt", "title", "colspan", "rowspan", "width", "height", "align"].includes(name)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body ? doc.body.innerHTML : "";
}
