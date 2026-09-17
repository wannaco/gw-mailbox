<script>
  import { appState, toast, statusMeta, composingLock, agentInitials, userName, STATUSES, markThreadRead, markNotesRead, threadUnreadNotes } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";
  import ContactPanel from "./ContactPanel.svelte";
  import { timeAgo, fmtDateTime, sanitizeHtml, isoLocalInput, avatarColor } from "../lib/utils.js";
  import { tick } from "svelte";

  let { threadId } = $props();

  const thread = $derived(appState.threads[threadId]);

  let tab = $state("conversation"); // conversation | notes
  let detailsOpen = $state(false); // collapse prev tickets + labels by default
  let composerOpen = $state(false); // reply editor starts collapsed (reading first)
  let contactOpen = $state(false);
  let replyText = $state(""); // kept in sync from the rich editor (innerText)
  let noteText = $state("");
  let editorEl; // contenteditable ref (plain let, not rune)
  let attachInput; // hidden file input ref
  let attachments = $state([]); // {name,size,mime,dataUrl}
  let busySend = $state(false);
  let busyNote = $state(false);
  let focused = $state(false);
  let meetOpen = $state(false);

  const messages = $derived(
    (appState.messages[threadId] || [])
      .slice()
      .sort((a, b) => msgEpoch(a) - msgEpoch(b) || String(a.id).localeCompare(String(b.id)))
  );
  const lock = $derived(composingLock(threadId));
  const isComposing = $derived(replyText.trim().length > 0 || attachments.length > 0 || focused);

  const msgsVisible = $derived(
    tab === "conversation"
      ? messages.filter((m) => !m.is_internal_note)
      : messages.filter((m) => m.is_internal_note)
  );

  // Unread internal notes — shown as a count on the Internal notes tab.
  const unreadNotes = $derived(threadUnreadNotes(threadId));

  // Clear the unread-notes badge only once the NOTES TAB has actually been shown.
  // Deliberately NOT tied to markThreadRead: opening a thread lands on the
  // conversation, so clearing there would mark notes read that were never seen.
  // Tracks the message list so a note arriving while the tab is open is marked
  // read too.
  $effect(() => {
    if (tab !== "notes") return;
    appState.messages[threadId]; // track loads and arrivals
    if (!threadId) return;
    markNotesRead(threadId);
  });

  // Other tickets from the same customer (in any inbox) — "previous tickets".
  const prevTickets = $derived(
    Object.values(appState.threads)
      .filter((t) => {
        if (t.id === threadId) return false;
        if (!thread?.customer_email) return false;
        return (
          (t.customer_email || "").toLowerCase() === String(thread.customer_email).toLowerCase()
        );
      })
      .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))
      .slice(0, 3)
  );

  // ---- CSAT (surveys sent when this ticket closed; results shown here) ----
  let csatSurveys = $state([]); // { rating, comment, sent_at, responded_at, url }
  async function loadCsat() {
    const tid = threadId;
    if (!tid) return;
    try {
      const r = await api.pbRequest("GET", `/mailbox/threads/${tid}/csat`);
      if (r && r.ok) csatSurveys = r.surveys || [];
    } catch { /* non-fatal */ }
  }
  $effect(() => { loadCsat(); });

  function copyCsatLink(s) {
    try {
      navigator.clipboard.writeText(s.url);
      toast("success", "CSAT link copied");
    } catch {
      toast("error", "Could not copy");
    }
  }

  // ---- message ordering -------------------------------------------------------
  function msgEpoch(m) {
    const s = String(m.msg_date || "").trim();
    if (!s) return Number.MAX_SAFE_INTEGER; // unknown date -> sort LAST, never first
    const t = new Date(s.includes("T") ? s : s.replace(" ", "T")).getTime();
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  // While this thread is open, keep it marked read (new messages arriving live
  // stay "read" because the agent is looking at them).
  $effect(() => {
    const tid = threadId;
    const list = appState.messages[tid];
    if (!tid || !list || !list.length) return;
    markThreadRead(tid);
    // jump to a specific message (from a notification) once the list is ready
    const target = appState.jumpToMessage;
    if (target) {
      const rec = list.find((m) => m.id === target);
      if (rec && rec.is_internal_note) tab = "notes";
      setTimeout(() => {
        const el = document.querySelector(`[data-msg-id="${CSS.escape(target)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 2000);
        }
        appState.jumpToMessage = null;
      }, 150);
    }
  });

  // Publish MY app-wide presence while this thread is open (roster heartbeat).
  $effect(() => {
    const tid = threadId;
    if (!tid) return;
    appState.myActivity = {
      thread: tid,
      status: isComposing ? "composing_reply" : "viewing"
    };
  });

  // Who ELSE is currently on this thread (viewing or composing) — live via
  // thread_presence snapshot + SSE. Excludes this client's own presence row.
  const othersOnThread = $derived(
    Object.values(appState.presence)
      .filter((p) => p.thread === threadId && p.user !== appState.me?.id && p.user !== "")
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "composing_reply" ? -1 : 1))
  );

  // ---- presence lifecycle: heartbeat while open, seed snapshot, release -----
  async function sendHeartbeat(status) {
    try {
      await api.heartbeat(threadId, status);
    } catch { /* transient */ }
  }

  $effect(() => {
    const tid = threadId;
    if (!tid) return;

    // Fresh compose session per thread: drop any previous draft/signature.
    composerOpen = false;
    sigState = 0;
    if (editorEl) { editorEl.innerHTML = ""; }
    replyText = "";

    // initial load + seed presence names
    api.fetchMessages(tid).catch(() => {});
    api
      .pbRequest("GET", `/mailbox/threads/${tid}/presence`)
      .then((r) => {
        for (const p of r?.presence || []) {
          appState.presence[`${tid}:${p.userId}`] = {
            thread: tid,
            user: p.userId,
            status: p.status,
            agentName: p.agentName,
            updatedAt: p.updatedAt
          };
        }
      })
      .catch(() => {});

    const timer = setInterval(() => {
      sendHeartbeat(isComposing ? "composing_reply" : "viewing");
    }, 6000);
    sendHeartbeat("viewing"); // join immediately

    return () => {
      clearInterval(timer);
      try {
        api.releasePresence(tid).catch(() => {});
      } catch { /* ignore */ }
    };
  });

  // ---- rich editor helpers ----------------------------------------------------
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function editorHtml() {
    return editorEl ? editorEl.innerHTML : "";
  }
  function editorText() {
    return editorEl ? (editorEl.innerText || "") : "";
  }
  function onEditorInput() {
    replyText = editorText();
    detectSlash();
    syncLiveSignature(); // show the signature live while typing (Gmail-style)
  }

  // ---- canned responses / slash commands -------------------------------------
  let canned = $state([]); // { id, title, body }
  let slash = $state(null); // { query }
  let slashIdx = $state(0);

  async function loadCanned() {
    try {
      const r = await api.listCanned();
      canned = (r.items || []).map((c) => ({ id: c.id, title: c.title, body: c.body }));
    } catch { /* non-fatal */ }
  }

  $effect(() => {
    if (threadId) loadCanned();
  });

  function editorTextBeforeCaret() {
    const el = editorEl;
    const sel = window.getSelection && window.getSelection();
    if (!el || !sel || !sel.rangeCount) return "";
    try {
      const range = sel.getRangeAt(0).cloneRange();
      range.selectNodeContents(el);
      range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      return range.toString();
    } catch (_) {
      return "";
    }
  }

  function detectSlash() {
    const before = editorTextBeforeCaret();
    const m = before.match(/(?:^|\s)\/([^\s\/]*)$/);
    if (m) {
      if (slash && slash.query === m[1]) return;
      slash = { query: m[1] || "" };
      slashIdx = 0;
    } else {
      slash = null;
    }
  }

  // Matches are NOT capped at a handful any more. The old `.slice(0, 8)` hid
  // everything past the eighth match with no indication there was more, so a
  // long catalog became unreachable. The list scrolls instead, and the footer
  // reports the count so it is obvious when there is more to see.
  const SLASH_MAX = 50;
  const slashMatches = $derived(
    slash
      ? canned.filter((c) => {
          const q = (slash.query || "").toLowerCase();
          if (!q) return true;
          return (
            (c.title || "").toLowerCase().includes(q) ||
            (c.body || "").toLowerCase().includes(q)
          );
        })
      : []
  );
  const slashItems = $derived(slashMatches.slice(0, SLASH_MAX));
  const slashHidden = $derived(Math.max(0, slashMatches.length - slashItems.length));

  // Escape first, then wrap the matched run — so highlighting can never inject
  // markup from a canned response's own text.
  function hl(text, query) {
    const t = String(text || "");
    const q = String(query || "");
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return (
      esc(t.slice(0, i)) +
      "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" +
      esc(t.slice(i + q.length))
    );
  }

  let slashListEl = $state(null);

  // Keep the keyboard-selected row in view while arrowing through the list.
  // scrollTop is adjusted directly rather than with scrollIntoView(), which can
  // also scroll the page behind the drawer.
  $effect(() => {
    const idx = slashIdx;
    const el = slashListEl;
    if (!el) return;
    const li = el.querySelector(`[data-slash-item="${idx}"]`);
    if (!li) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  });

  // Walk backwards from the caret to select the `/query` token (generic).
  function caretTokenRange(caretNode, caretOffset, marker) {
    const doc = document;
    const range = doc.createRange();
    let node = caretNode;
    let off = caretOffset;
    let guard = 0;
    while (node && guard++ < 80) {
      if (node.nodeType === 3) {
        const txt = node.nodeValue || "";
        let i = off;
        while (i > 0) {
          const ch = txt[i - 1];
          if (ch === marker) {
            range.setStart(node, i - 1);
            range.setEnd(caretNode, caretOffset);
            return range;
          }
          if (/\s/.test(ch)) return null;
          i--;
        }
        node = node.previousSibling;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      } else if (node.nodeType === 1) {
        node = node.lastChild;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      } else {
        node = node.previousSibling;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      }
    }
    return null;
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Resolve {{placeholders}} from the open thread at insert time. Known tokens
  // are filled with live values; UNKNOWN ones are left literal so teams can
  // type notes like {{order_id}} without them being swallowed.
  function fillCannedPlaceholders(text) {
    const t = thread;
    const inbox = (appState.inboxes || []).find((i) => i.id === t?.inbox);
    const map = {
      "{{customer_name}}": (t?.customer_name || "") || t?.customer_email || "",
      "{{customer_email}}": t?.customer_email || "",
      "{{subject}}": t?.subject || "(no subject)",
      "{{thread_subject}}": t?.subject || "(no subject)",
      "{{inbox}}": inbox?.email_address || ""
    };
    let out = String(text || "");
    for (const k in map) out = out.split(k).join(map[k]);
    return out;
  }

  // Replace the /token with the canned body as rich paragraphs.
  function pickCanned(c) {
    const el = editorEl;
    const sel = window.getSelection && window.getSelection();
    const body = fillCannedPlaceholders(c.body);
    if (el && sel && sel.rangeCount) {
      const caret = sel.getRangeAt(0);
      const range = caretTokenRange(caret.startContainer, caret.startOffset, "/");
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const paras = String(body || "")
        .split(/\n+/)
        .map((p) => "<p>" + esc(p).trim() + "</p>")
        .join("");
      try {
        document.execCommand("insertHTML", false, paras);
      } catch (_) {
        document.execCommand("insertText", false, body || "");
      }
    } else if (el) {
      el.innerHTML += "<p>" + esc(body || "").replace(/\n+/g, "</p><p>") + "</p>";
    }
    slash = null;
    replyText = editorText();
    el && el.focus();
  }

  function onEditorKeydown(ev) {
    if (!slash) return;
    // Escape closes the menu even when nothing matched — otherwise a query with
    // no results left the menu logically open but invisible and unresponsive.
    if (ev.key === "Escape") { slash = null; return; }
    if (!slashItems.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const len = slashItems.length;
      slashIdx = (slashIdx + (ev.key === "ArrowDown" ? 1 : -1) + len) % len;
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      // Fall back to the first row: arrow-wrap can leave slashIdx past the end
      // when typing shrinks the filtered list mid-navigation.
      pickCanned(slashItems[slashIdx] || slashItems[0]);
    }
  }

  function exec(cmd, val) {
    if (!editorEl) return;
    editorEl.focus();
    try {
      document.execCommand(cmd, false, val || null);
    } catch (_) { /* ignored */ }
    onEditorInput();
  }
  // ---- insert-link dialog -----------------------------------------------------
  // Replaces window.prompt(). A native prompt is browser chrome: it can't be
  // styled, it blocks the whole tab, and some browsers suppress it outright.
  //
  // The old code called document.execCommand("createLink"), which needs a live
  // selection *inside* the editor. Clicking the toolbar button moves focus to
  // the prompt and drops that selection, so createLink silently did nothing
  // unless text happened to be selected. This places a real <a> node instead,
  // which works with or without a selection and can't fail the same way.
  let linkOpen = $state(false);
  let linkUrl = $state("");
  let linkFor = $state("composer"); // composer | note
  let linkErr = $state("");
  let linkInputEl;
  let savedRange = null; // the editor's caret/selection, captured before focus moves

  // The dialog's input takes focus, which drops the editor's selection — and
  // the selection is where the link has to go. So snapshot it first. Without
  // this the browser reports a collapsed range at offset 0 and the link lands
  // at the START of the draft instead of where the user was typing.
  function captureCaret(el) {
    savedRange = null;
    if (!el) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return;
    try {
      const r = sel.getRangeAt(0);
      if (el.contains(r.startContainer)) savedRange = r.cloneRange();
    } catch (_) { savedRange = null; }
  }

  function openLinkDialog(which) {
    linkFor = which;
    linkUrl = "";
    linkErr = "";
    linkOpen = true;
    tick().then(() => linkInputEl && linkInputEl.focus());
  }

  function closeLinkDialog() {
    savedRange = null;
    linkOpen = false;
  }

  // "example.com" is what people actually type, so assume https. Anything that
  // isn't http(s) is refused: javascript:/data: are how a pasted "link" turns
  // into XSS in an email body.
  function normalizeUrl(raw) {
    const v = String(raw || "").trim();
    if (!v) return { err: "Enter a URL." };
    const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v) ? v : "https://" + v;
    let u;
    try { u = new URL(withProto); } catch (_) { return { err: "That doesn't look like a URL." }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { err: "Only http:// and https:// links can be inserted." };
    }
    return { href: u.href };
  }

  // Puts an <a> at the captured caret. If text was selected, that text becomes
  // the link's own label (so it reads as a link, not a pasted URL); otherwise
  // the URL is inserted as the link text.
  // New URL() percent-encodes quotes, so href is safe in an attribute.
  function placeLink(el, href, isNote) {
    if (!el) return false;
    el.focus();
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");

    const sel = window.getSelection && window.getSelection();
    let range = null;
    if (savedRange && el.contains(savedRange.startContainer)) range = savedRange;
    else if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) range = sel.getRangeAt(0);

    const selectedText = range && !range.collapsed ? String(range.toString() || "") : "";
    a.textContent = selectedText || href;

    if (range) {
      try {
        range.deleteContents();
        range.insertNode(a);
        const after = document.createRange();
        after.setStartAfter(a);
        after.collapse(true);
        if (sel) { sel.removeAllRanges(); sel.addRange(after); }
        savedRange = after.cloneRange();
      } catch (_) { el.appendChild(a); }
    } else {
      el.appendChild(a);
    }
    savedRange = null;
    if (isNote) onNoteEditorInput(); else onEditorInput();
    return true;
  }

  function confirmLink() {
    const norm = normalizeUrl(linkUrl);
    if (norm.err) { linkErr = norm.err; return; }
    const ok = placeLink(linkFor === "composer" ? editorEl : noteEditorEl, norm.href, linkFor === "note");
    if (!ok) { linkErr = "The editor isn't open — try again."; return; }
    linkOpen = false;
  }

  function onLinkKey(ev) {
    if (ev.key === "Enter") { ev.preventDefault(); confirmLink(); }
    else if (ev.key === "Escape") { ev.preventDefault(); closeLinkDialog(); }
  }

  function addLink() {
    if (lock) return;
    captureCaret(editorEl);
    openLinkDialog("composer");
  }

  // ---- attachment handling ----------------------------------------------------
  function onFilesPicked(ev) {
    const files = Array.from(ev.target.files || []);
    attachInput && (attachInput.value = "");
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) {
        toast("error", f.name + " is over 25MB");
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        attachments = [...attachments, { name: f.name, size: f.size, mime: f.type || "application/octet-stream", dataUrl: String(reader.result || "") }];
      };
      reader.readAsDataURL(f);
    }
  }
  function removeAttachment(i) {
    attachments = attachments.filter((_, idx) => idx !== i);
  }

  // ---- recipients / reply-all ------------------------------------------------
  let replyMode = $state("reply"); // reply | replyAll
  let ccList = $state([]); // extra Cc recipients for this send
  let newCc = $state("");
  let openRecips = $state({}); // messageId -> bool (expand "to N")

  const inboxEmail = $derived(
    (appState.inboxes.find((i) => i.id === appState.activeInboxId) || {}).email_address || ""
  );

  // Split a message's stored recipients into To vs Cc for display.
  function msgRecips(m) {
    const all = Array.isArray(m.recipient_emails) ? m.recipient_emails : [];
    const cc = Array.isArray(m.cc_emails) ? m.cc_emails.filter((c) => all.includes(c)) : [];
    const to = all.filter((a) => !cc.includes(a));
    return { to, cc };
  }

  function msgRecipCount(m) {
    return (m.recipient_emails || []).length;
  }

  function toggleRecips(id) {
    openRecips = { ...openRecips, [id]: !openRecips[id] };
  }

  // Candidates for "Reply all": everyone on the LAST message in the thread
  // (inbound or outbound, mirroring Gmail) except our own inbox address and
  // the primary customer we're replying to.
  function replyAllCandidates() {
    const last = msgsVisible.filter((m) => !m.is_internal_note).slice(-1)[0];
    if (!last) return [];
    const uid = inboxEmail.toLowerCase();
    const cust = (thread?.customer_email || "").toLowerCase();
    return (last.recipient_emails || []).filter(
      (r) => r.toLowerCase() !== uid && r.toLowerCase() !== cust
    );
  }

  const canReplyAll = $derived(replyAllCandidates().length > 0);

  function setReplyMode(mode) {
    replyMode = mode;
    if (mode === "replyAll") ccList = replyAllCandidates();
    else ccList = [];
  }

  function removeCc(email) {
    ccList = ccList.filter((c) => c.toLowerCase() !== String(email).toLowerCase());
  }

  function addCc() {
    const v = newCc.trim().toLowerCase();
    if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return;
    if (!ccList.some((c) => c.toLowerCase() === v)) ccList = [...ccList, v];
    newCc = "";
  }

  // ---- actions --------------------------------------------------------------
  // ---- signature support ----------------------------------------------------
  // The signed-in agent's signature (plain multi-line text) — set in My profile
  // (or by an admin). Builds a Gmail-style "-- \n\n<lines>" block.
  function mySignature() {
    const me = appState.me;
    if (!me || !me.signature) return "";
    return String(me.signature).trim();
  }
  function sigText() {
    const s = mySignature();
    return s ? "\n\n-- \n" + s : "";
  }
  // Signature as plain <p> lines (what actually goes in the email).
  function sigInnerHtml() {
    const s = mySignature();
    if (!s) return "";
    const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const ps = ["<p>-- </p>"].concat(s.split(/\r?\n/).map((l) => "<p>" + esc(l) + "</p>"));
    return ps.join("");
  }
  // Signature wrapped in a marker div — the LIVE editor shows this so the user
  // sees (and can edit/delete) their signature while composing, Gmail-style.
  function sigBlockHtml() {
    return '<div class="mb-sig">' + sigInnerHtml() + "</div>";
  }
  function sigInEditor() {
    return !!(editorEl && editorEl.querySelector(".mb-sig"));
  }
  // Editor text EXCLUDING the signature block (what the user actually wrote).
  function editorBodyText() {
    const el = editorEl;
    if (!el) return "";
    const t = el.innerText || "";
    const sigEl = el.querySelector(".mb-sig");
    if (!sigEl) return t.trim();
    return t.replace(sigEl.innerText || "", "").trim();
  }
  // sigState: 0 = none/cleared, 1 = sig present, 2 = user removed it this reply.
  let sigState = 0;
  function resetSigState() {
    sigState = 0;
  }
  // Gmail-style: once the user has typed something and auto-insert is on, show
  // the signature at the bottom of the editor live. If they delete it, respect
  // that (state 2) so it does NOT come back mid-reply; clearing everything resets.
  function syncLiveSignature() {
    const el = editorEl;
    if (!el) return;
    const me = appState.me;
    if (!(me && me.signature_auto && me.signature)) return;
    const body = editorBodyText();
    if (!body) { sigState = 0; return; }
    if (sigInEditor()) { sigState = 1; return; }
    if (sigState === 1) { sigState = 2; return; } // user deleted the sig but kept text
    if (sigState === 2) return;
    el.insertAdjacentHTML("beforeend", sigBlockHtml());
    sigState = 1;
    replyText = editorText();
  }
  // Manual insert (✍️) — appends the live sig block if it isn't already there.
  function insertSignature() {
    const el = editorEl;
    if (!el) return;
    if (sigInEditor()) { toast("info", "Signature already in this reply"); return; }
    el.insertAdjacentHTML("beforeend", sigBlockHtml());
    sigState = 1;
    el.focus();
    replyText = editorText();
    toast("success", "Signature added");
  }

  // The reply editor is collapsed by default and only mounts when opened, so
  // focus has to wait for the DOM to update.
  async function openComposer() {
    if (lock) return;
    composerOpen = true;
    await tick();
    if (editorEl) editorEl.focus();
  }

  async function sendReply() {
    const hasAtt = attachments.length > 0;
    let text = editorText().trim();
    let html = editorHtml();
    if ((!text && !html.replace(/<[^>]*>/g, "").trim() && !hasAtt) || busySend || lock) return;
    busySend = true;
    // Live signature: with auto-insert on and content present, make sure the
    // signature is visible in the box before sending (covers attachment-only
    // sends too). If the user removed it (sigState 2), don't force it back.
    if (appState.me?.signature_auto && mySignature() && sigState !== 2 && !sigInEditor() && (text || hasAtt)) {
      if (editorEl) { editorEl.insertAdjacentHTML("beforeend", sigBlockHtml()); sigState = 1; }
      text = editorText().trim();
      html = editorHtml();
    }
    // Unwrap the live marker so the actual email has plain paragraphs (no div).
    html = html.replace(/<div class="mb-sig">([\s\S]*?)<\/div>/gi, "$1");
    try {
      await api.sendReply(threadId, {
        body: text,
        html: html,
        cc: replyMode === "replyAll" ? ccList : [],
        attachments: attachments.map((a) => ({
          name: a.name,
          mime: a.mime,
          data: a.dataUrl // server strips the data: prefix
        }))
      });
      toast("success", hasAtt ? "Reply sent with " + attachments.length + " attachment" + (attachments.length > 1 ? "s" : "") : "Reply sent");
      if (editorEl) editorEl.innerHTML = "";
      attachments = [];
      replyText = "";
      sigState = 0;
      ccList = [];
      replyMode = "reply";
      composerOpen = false; // re-collapse so the sent reply gets the space
      await api.fetchMessages(threadId); // show the sent message immediately
    } catch (e) {
      toast("error", "Send failed: " + (e?.message || ""));
    } finally {
      busySend = false;
    }
  }

  // ---- note editor (rich, same toolbar as reply) + @mention ----------------
  let noteEditorEl;
  let noteFocused = $state(false);
  let mention = $state(null); // { query }
  let mentionIdx = $state(0);

  function notePlain() {
    return noteEditorEl ? (noteEditorEl.innerText || "").trim() : "";
  }
  function noteHtml() {
    return noteEditorEl ? noteEditorEl.innerHTML : "";
  }
  function onNoteEditorInput() {
    noteText = notePlain();
    detectMention();
  }
  function execNote(cmd, val) {
    if (!noteEditorEl) return;
    noteEditorEl.focus();
    try {
      document.execCommand(cmd, false, val || null);
    } catch (_) { /* ignored */ }
    noteText = notePlain();
    detectMention();
  }
  function addNoteLink() {
    captureCaret(noteEditorEl);
    openLinkDialog("note");
  }

  function noteTextBeforeCaret() {
    const el = noteEditorEl;
    const sel = window.getSelection && window.getSelection();
    if (!el || !sel || !sel.rangeCount) return "";
    try {
      const range = sel.getRangeAt(0).cloneRange();
      range.selectNodeContents(el);
      range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      return range.toString();
    } catch (_) {
      return "";
    }
  }

  function detectMention() {
    const before = noteTextBeforeCaret();
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      // trigger as soon as '@' is typed (query may be empty)
      if (mention && mention.query === m[1]) return; // no change
      mention = { query: m[1] || "" };
      mentionIdx = 0;
    } else {
      mention = null;
    }
  }

  // Candidates derived reactively from the mention query + team directory.
  const mentionItems = $derived(
    mention
      ? Object.values(appState.users)
          .filter((u) => {
            const q = (mention.query || "").toLowerCase();
            if (!q) return true;
            return (
              (u.name || "").toLowerCase().includes(q) ||
              (u.email || "").toLowerCase().includes(q)
            );
          })
          .slice(0, 8)
      : []
  );

  function mentionRangeFor(caretNode, caretOffset) {
    // Selects the '@query' token ending at the caret (same text node walk).
    const doc = document;
    const range = doc.createRange();
    let node = caretNode;
    let off = caretOffset;
    let guard = 0;
    while (node && guard++ < 80) {
      if (node.nodeType === 3) {
        const txt = node.nodeValue || "";
        let i = off;
        while (i > 0) {
          const ch = txt[i - 1];
          if (ch === "@") {
            range.setStart(node, i - 1);
            range.setEnd(caretNode, caretOffset);
            return range;
          }
          if (/\s/.test(ch)) return null;
          i--;
        }
        node = node.previousSibling;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      } else if (node.nodeType === 1) {
        node = node.lastChild;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      } else {
        node = node.previousSibling;
        if (node) off = node.nodeType === 3 ? (node.nodeValue || "").length : 0;
      }
    }
    return null;
  }

  function pickMention(u) {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && noteEditorEl) {
      const caret = sel.getRangeAt(0);
      const range = mentionRangeFor(caret.startContainer, caret.startOffset);
      if (range) {
        caret.setStart(range.startContainer, range.startOffset);
        caret.collapse(true);
      }
      // remove the typed token if we found it, then insert mention text
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, "@" + (u.name || u.email) + " ");
      } else {
        document.execCommand("insertText", false, "@" + (u.name || u.email) + " ");
      }
    }
    mention = null;
    noteText = notePlain();
    noteEditorEl && noteEditorEl.focus();
  }

  function onNoteEditorKeydown(ev) {
    if (!mention || !mentionItems.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const len = mentionItems.length;
      mentionIdx = (mentionIdx + (ev.key === "ArrowDown" ? 1 : -1) + len) % len;
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      pickMention(mentionItems[mentionIdx]);
    } else if (ev.key === "Escape") {
      mention = null;
    }
  }

  async function submitNote() {
    const text = notePlain();
    const html = noteHtml();
    if ((!text && !html.replace(/<[^>]*>/g, "").trim()) || busyNote) return;
    busyNote = true;
    try {
      await api.addNote(threadId, { body: text, html });
      toast("success", "Internal note added");
      if (noteEditorEl) noteEditorEl.innerHTML = "";
      noteText = "";
      mention = null;
      await api.fetchMessages(threadId); // show the note immediately
    } catch (e) {
      toast("error", e?.message || "Could not add note");
    } finally {
      busyNote = false;
    }
  }

  async function setStatus(e) {
    const status = e.target.value;
    const prev = thread.status;
    thread.status = status;
    try {
      await api.moveThread(threadId, status);
    } catch (err) {
      thread.status = prev;
      toast("error", "Status update failed");
    }
  }

  // ---- assignee + labels -----------------------------------------------------
  let catalog = $state([]); // {id,name,color}
  let labelsOpen = $state(false);
  let newLabelName = $state("");
  let busyAssign = $state(false);

  const threadTags = $derived(Array.isArray(thread?.tags) ? thread.tags : []);
  // Assignee list = agents only (admins are mentionable but not assignable).
  const assigneeOptions = $derived(
    Object.values(appState.users)
      .filter((u) => (u.kind || 'agent') !== 'admin')
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
  );

  async function loadCatalog() {
    try {
      const r = await api.listLabels();
      catalog = (r.items || []).map((l) => ({ id: l.id, name: l.name, color: l.color || "" }));
    } catch { /* non-fatal */ }
  }

  $effect(() => {
    if (threadId) loadCatalog();
  });

  function tagColor(name) {
    const hit = catalog.find((l) => l.name === name);
    return hit ? hit.color : "#888";
  }

  async function persistTags(next) {
    thread.tags = next;
    try {
      await api.moveThread(threadId, thread.status, { tags: next });
    } catch (err) {
      toast("error", "Could not save labels");
    }
  }

  async function toggleTag(name) {
    const has = threadTags.includes(name);
    if (has) {
      await persistTags(threadTags.filter((t) => t !== name));
    } else {
      // ensure catalog entry exists first (agents may create on the fly)
      if (!catalog.find((l) => l.name === name)) {
        try {
          await api.createLabelRecord({ name, color: "#0b57d0" });
        } catch { /* ignore dup */ }
        loadCatalog();
      }
      await persistTags([...threadTags, name]);
    }
  }

  async function addCustomLabel() {
    const name = newLabelName.trim();
    if (!name) return;
    if (!catalog.find((l) => l.name === name)) {
      try {
        await api.createLabelRecord({ name, color: "#0b57d0" });
        await loadCatalog();
      } catch { /* dup */ }
    }
    if (!threadTags.includes(name)) await persistTags([...threadTags, name]);
    newLabelName = "";
  }

  async function setAssignee(v) {
    busyAssign = true;
    try {
      thread.assigned_agent = v;
      await api.moveThread(threadId, thread.status, { assigned_agent: v });
    } catch (err) {
      toast("error", "Assign failed");
    } finally {
      busyAssign = false;
    }
  }

  // ---- meet scheduler (calendar modal) --------------------------------------
  let meetDays = $state([]); // Date[] — next 7 days
  let meetIdx = $state(0);
  let busyList = $state([]); // [{start,end}]
  let busyLoading = $state(false);
  let busyMsg = $state("");
  let selStart = $state(null); // Date | null
  let meetDur = $state(30);
  let meetSummary = $state("");
  let meetNote = $state("");
  let meeting = $state(false);
  let meetErr = $state("");
  const DAY_START_MIN = 8 * 60; // 08:00
  const DAY_END_MIN = 19 * 60; // 19:00
  // freebusy only needs to be fine-grained enough to detect a clash with any
  // offered slot; the slot grid itself is derived from the duration.
  const BUSY_STEP = 15;

  function dayStart(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  // The grid IS the list of bookable meetings: the day is divided into slots
  // of exactly `dur` minutes, so a slot is something you can book as-is rather
  // than a fixed 30-minute box that sometimes lights up in pairs.
  //
  // That also makes the busy check honest. A 30-minute grid only tests the
  // first half hour of an hour-long booking, so a meeting at 09:15 looked free
  // for a 09:00-10:00 slot. Checking the whole [start, start+dur) span is what
  // the old code got wrong.
  function daySlots(d, dur) {
    const out = [];
    const base = dayStart(d).getTime();
    for (let m = DAY_START_MIN; m + dur <= DAY_END_MIN; m += dur) {
      out.push(new Date(base + m * 60000));
    }
    return out;
  }

  function slotEnd(d, dur) {
    return new Date(d.getTime() + (dur || meetDur) * 60000);
  }

  function overlapsBusy(start, mins) {
    const s = start.getTime();
    const e = s + mins * 60000;
    return busyList.some((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s);
  }

  function cellBusy(d) {
    return overlapsBusy(d, meetDur);
  }
  function cellPast(d) {
    return d.getTime() < Date.now() - 60000;
  }

  const selectedDay = $derived(meetDays[meetIdx]);
  const selectedCells = $derived(selectedDay ? daySlots(selectedDay, meetDur) : []);

  function fmtDayLabel(d, withYear) {
    return d.toLocaleDateString([], withYear
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "short", day: "numeric" });
  }
  function fmtCellTime(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function fmtSlotRange(d) {
    return fmtCellTime(d) + " – " + fmtCellTime(slotEnd(d));
  }

  async function openMeet() {
    meetOpen = true;
    meetIdx = 0;
    busyList = [];
    busyMsg = "";
    busyLoading = true;
    selStart = null;
    meetErr = "";
    meetSummary = thread.subject || "Support meeting";
    meetNote = "";
    const today = new Date();
    meetDays = [];
    for (let i = 0; i < 7; i++) meetDays.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
    try {
      const start = dayStart(today);
      const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
      const res = await api.availability(threadId, isoLocalInput(start), isoLocalInput(end), 15);
      if (res && res.ok === false) {
        busyMsg = res.message || "Calendar unavailable.";
      } else {
        busyList = (res?.busy || []).map((b) => ({ start: b.start, end: b.end }));
      }
    } catch (e) {
      busyMsg = e?.message || "Calendar unavailable (Google credentials?).";
    } finally {
      busyLoading = false;
    }
  }

  function closeMeet() {
    meetOpen = false;
  }

  function clickCell(d) {
    if (cellBusy(d) || cellPast(d)) return;
    selStart = d;
    meetErr = "";
  }

  // Changing the duration re-divides the day, so the previously picked start
  // may not exist any more (09:30 is a slot at 30m but not at 60m). Keep the
  // selection only if that exact start is still an offerable slot; otherwise
  // drop it rather than silently moving the meeting.
  function setDuration(d) {
    if (d === meetDur) return;
    meetDur = d;
    meetErr = "";
    if (!selStart || !selectedDay) return;
    const stillOffered = daySlots(selectedDay, d).some((s) => s.getTime() === selStart.getTime());
    if (!stillOffered || overlapsBusy(selStart, d)) selStart = null;
  }

  const meName = $derived(appState.me?.name || appState.me?.email || "");

  async function createMeeting() {
    if (!selStart) {
      meetErr = "Pick a free time slot first.";
      return;
    }
    meeting = true;
    meetErr = "";
    try {
      const end = new Date(selStart.getTime() + meetDur * 60000);
      const res = await api.bookMeet(threadId, {
        start: isoLocalInput(selStart),
        end: isoLocalInput(end),
        summary: meetSummary.trim() || thread.subject || "Support meeting",
        description: meetNote.trim() || undefined,
        hostEmail: appState.me?.email || undefined
      });
      if (res && res.ok === false) {
        meetErr = res.message || "Booking failed.";
      } else {
        toast("success", "Meet booked — " + (res.hangoutLink || "check the note"));
        meetOpen = false;
        await api.fetchMessages(threadId);
      }
    } catch (e) {
      meetErr = e?.message || "Booking failed.";
    } finally {
      meeting = false;
    }
  }

  async function cancelLinkedMeet() {
    if (!confirm("Cancel the linked Google Meet?")) return;
    try {
      await api.cancelMeet(threadId);
      thread.calendar_event_id = "";
      toast("success", "Meeting cancelled");
    } catch (e) {
      toast("error", e?.message || "Cancel failed");
    }
  }
</script>

{#if thread}
  <div class="tv-root">
  <header class="tv-head">
    <div class="tv-title-row">
      <button class="md3-icon-btn close" onclick={() => (appState.openThreadId = "")} title="Close">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>
      </button>
      <div class="tv-title">
        <h3>{thread.subject || "(no subject)"}</h3>
        <span class="cust">
          {thread.customer_name ? thread.customer_name + " · " : ""}{thread.customer_email || "no customer"}
          {#if thread.last_message_at} · {timeAgo(thread.last_message_at)}{/if}
          {#if thread.customer_email}
            <button type="button" class="contact-btn" onclick={() => (contactOpen = true)} title="View / edit contact">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
              Contact
            </button>
          {/if}
        </span>
      </div>
      <select class="status-select" value={thread.status} onchange={setStatus}
        style="--sc:{statusMeta(thread.status).dot}">
        {#each STATUSES as s (s.value)}
          <option value={s.value}>{s.label}</option>
        {/each}
      </select>
    </div>

    <!-- Only two rows by default: the title block above, and this bar. The
         secondary controls (assignee, labels, meeting, previous tickets) fold
         behind "Details" so the message body gets the vertical space — the
         header used to take ~187px, over a fifth of the drawer. -->
    <div class="tv-actions">
      <button class="md3-chip" class:is-active={tab === "conversation"} onclick={() => (tab = "conversation")}>
        Conversation ({msgsVisible.length})
      </button>
      <button class="md3-chip" class:is-active={tab === "notes"} onclick={() => (tab = "notes")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm12-2h4v10a1 1 0 0 1-1 1h-3v-2h2v-7h-2z"/></svg>
        Internal notes{#if unreadNotes > 0}<span class="tab-badge">{unreadNotes}</span>{/if}
      </button>
      <div class="spacer"></div>
      <select class="assignee-sel" value={thread.assigned_agent || ""} onchange={(e) => setAssignee(e.target.value)} disabled={busyAssign} title="Assignee">
        <option value="">Unassigned</option>
        {#each assigneeOptions as u (u.id)}
          <option value={u.id}>{u.name || u.email}</option>
        {/each}
      </select>
      <button type="button" class="detail-toggle" onclick={() => (detailsOpen = !detailsOpen)} aria-expanded={detailsOpen}
        title="Labels, meeting, previous tickets">
        <svg class="chev" class:open={detailsOpen} width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        <span class="detail-summary">
          Details{#if prevTickets.length || threadTags.length}&nbsp;({prevTickets.length + threadTags.length}){/if}
        </span>
      </button>
    </div>

    {#if detailsOpen}
      <div class="detail-body head-details">
        <div class="dt-chips">
          <div class="lbl-wrap">
            <button class="md3-chip" class:is-active={labelsOpen} onclick={() => (labelsOpen = !labelsOpen)} title="Labels">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 15.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
              Labels
            </button>
            {#if labelsOpen}
              <div class="lbl-menu">
                {#each catalog as lb (lb.id)}
                  <label class="lbl-item">
                    <input type="checkbox" checked={threadTags.includes(lb.name)} onchange={() => toggleTag(lb.name)} />
                    <span class="lbl-dot" style="background:{lb.color || '#888'}"></span>{lb.name}
                  </label>
                {/each}
                <div class="lbl-new">
                  <input type="text" bind:value={newLabelName} placeholder="New label…" onkeydown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addCustomLabel(); } }} />
                  <button class="md3-btn tonal small" onclick={addCustomLabel}>Add</button>
                </div>
              </div>
            {/if}
          </div>
          <button class="md3-btn tonal small" onclick={openMeet} disabled={!!lock}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 10.5 21 7v10l-6-3.5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v4.5z"/></svg>
            Book Meet
          </button>
        </div>
        {#if threadTags.length}
          <div class="dt-group">
            <span class="dt-label">Labels</span>
            <div class="dt-chips">
              {#each threadTags as tg (tg)}
                <span class="dt-chip plain" style="background:{tagColor(tg)}22;color:{tagColor(tg)}">{tg}</span>
              {/each}
            </div>
          </div>
        {/if}
        {#if prevTickets.length}
          <div class="dt-group">
            <span class="dt-label">Previous tickets</span>
            <div class="dt-chips">
              {#each prevTickets as pt (pt.id)}
                <button type="button" class="dt-chip" onclick={() => (appState.openThreadId = pt.id)} title={pt.subject || "(no subject)"}>
                  {pt.subject || "(no subject)"}
                  <span class="dt-status" style="color:{statusMeta(pt.status).dot}">{statusMeta(pt.status).label}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </header>

  {#if othersOnThread.length}
    <div class="tv-presence">
      {#each othersOnThread as p (p.user)}
        <span class="pv-chip" title={`${p.agentName || userName(p.user)} — ${p.status === "composing_reply" ? "composing a reply" : "viewing this thread"}`}>
          {#if p.status === "composing_reply"}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
          {/if}
          <span class="pv-name">{p.agentName || userName(p.user)}</span>
        </span>
      {/each}
    </div>
  {/if}

  {#if lock}
    <div class="lock-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      <span><strong>{lock.agentName}</strong> is drafting a reply — composing is locked.</span>
    </div>
  {/if}

  {#if csatSurveys.length}
    <div class="csat-strip">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.3l7.1-.7z"/></svg>
      <div class="csat-items">
        {#each csatSurveys as s (s.id)}
          <div class="csat-item">
            {#if s.rating}
              <span class="csat-stars" aria-label={`${s.rating} of 5`}>
                {#each [1,2,3,4,5] as n (n)}<span class:lit={n <= s.rating}>★</span>{/each}
              </span>
              {#if s.comment}<span class="csat-comment-txt">“{s.comment}”</span>{/if}
              <span class="muted">{timeAgo(s.responded_at)}</span>
            {:else}
              <span class="muted">Survey sent — awaiting response.</span>
              <button class="link-btn" onclick={() => copyCsatLink(s)} title={s.url}>copy link</button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if meetOpen}
    <div class="meet-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeMeet(); }}>
      <div class="meet-modal" role="dialog" aria-modal="true" aria-label="Book a Google Meet">
        <header class="mm-head">
          <h3>Book a Google Meet</h3>
          <button class="md3-icon-btn" title="Close" onclick={closeMeet}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>
          </button>
        </header>

        {#if thread.calendar_event_id}
          <div class="mm-linked">
            <span>A meeting is already linked to this thread.</span>
            <button class="md3-btn tonal small" onclick={cancelLinkedMeet}>Cancel meeting</button>
          </div>
        {/if}

        <div class="mm-scroll">
          {#if busyLoading}
            <p class="muted center">Checking availability…</p>
          {:else}
            {#if busyMsg}
              <p class="muted" style="color:var(--m3-error)">{busyMsg}</p>
            {/if}

            <div class="mm-days">
              {#each meetDays as d, i (d.getTime())}
                <button
                  type="button"
                  class="mm-day"
                  class:on={i === meetIdx}
                  onclick={() => { meetIdx = i; selStart = null; meetErr = ""; }}
                >
                  <span class="mm-dw">{d.toLocaleDateString([], { weekday: "short" })}</span>
                  <span class="mm-dn">{d.getDate()}</span>
                  <span class="mm-dm">{d.toLocaleDateString([], { month: "short" })}</span>
                </button>
              {/each}
            </div>

            <div class="mm-dur-row">
              <span class="mm-lbl">Duration</span>
              <div class="mm-seg" role="group">
                {#each [15, 30, 45, 60] as d (d)}
                  <button type="button" class:on={meetDur === d} onclick={() => setDuration(d)}>{d}m</button>
                {/each}
              </div>
              <span class="mm-count">{selectedCells.length} slots</span>
            </div>

            <div class="mm-grid-wrap">
              <div class="mm-grid">
                {#each selectedCells as c (c.getTime())}
                  {@const busy = cellBusy(c)}
                  {@const past = cellPast(c)}
                  {@const sel = !!(selStart && c.getTime() === selStart.getTime())}
                  <button
                    type="button"
                    class="mm-cell"
                    class:busy={busy}
                    class:past={past}
                    class:sel={sel}
                    disabled={busy || past}
                    onclick={() => clickCell(c)}
                    title={busy ? "Busy" : past ? "In the past" : fmtSlotRange(c) + " (" + meetDur + " min)"}
                  >
                    <span class="mm-t">{fmtCellTime(c)}</span>
                  </button>
                {/each}
              </div>
              <div class="mm-legend">
                <span><i class="lg free"></i>Free</span>
                <span><i class="lg busy"></i>Busy</span>
                <span><i class="lg sel"></i>Selected</span>
              </div>
            </div>

            <p class="mm-chosen" class:picked={!!selStart}>
              {#if selStart}
                {fmtDayLabel(selStart, true)} · <b>{fmtSlotRange(selStart)}</b> · {meetDur} min
              {:else}
                Pick a start time — every slot below is {meetDur} minutes.
              {/if}
            </p>
          {/if}
        </div>

        <footer class="mm-foot">
          <div class="mm-fields">
            <input type="text" class="mm-summary" bind:value={meetSummary} placeholder="Summary (subject)" />
            <input type="text" class="mm-note" bind:value={meetNote} placeholder="Description / agenda (optional)" />
          </div>
          {#if meetErr}<p class="mm-err">{meetErr}</p>{/if}
          <div class="mm-actions">
            <span class="mm-with muted">With: {thread.customer_name || thread.customer_email || "—"}{#if meName} · Host: {meName}{/if}</span>
            <span class="spacer"></span>
            <button class="md3-btn tonal" onclick={closeMeet} disabled={meeting}>Cancel</button>
            <button class="md3-btn primary" onclick={createMeeting} disabled={meeting || busyLoading}>
              {meeting ? "Creating…" : "Create meeting"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  {/if}

  {#if linkOpen}
    <div class="link-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeLinkDialog(); }}>
      <div class="link-modal" role="dialog" aria-modal="true" aria-label="Insert link">
        <h3>Insert link</h3>
        <p class="lm-sub">Paste a URL. <b>example.com</b> works — https:// is assumed.</p>
        <input
          type="text"
          class="lm-input"
          placeholder="https://example.com"
          bind:this={linkInputEl}
          bind:value={linkUrl}
          onkeydown={onLinkKey}
          aria-invalid={linkErr ? "true" : undefined}
          aria-label="Link URL"
        />
        {#if linkErr}<p class="lm-err">{linkErr}</p>{/if}
        <div class="lm-actions">
          <span class="lm-hint">Enter to insert · Esc to cancel</span>
          <span class="spacer"></span>
          <button class="md3-btn tonal" onclick={closeLinkDialog}>Cancel</button>
          <button class="md3-btn primary" onclick={confirmLink}>Insert</button>
        </div>
      </div>
    </div>
  {/if}

  <div class="tv-body">
    {#if !msgsVisible.length}
      <p class="muted center">{tab === "notes" ? "No internal notes yet." : "No messages yet."}</p>
    {/if}
    {#each msgsVisible as m (m.id)}
      <article class:note={m.is_internal_note} class:external={!m.is_internal_note} data-msg-id={m.id}>
        <div class="msg-head">
          <span class="avatar" style="background:{avatarColor(m.sender_email)}">
            {agentInitials(m.sender_email)}
          </span>
          <span class="sender">{m.is_internal_note ? "Internal note · " + (m.sender_email || "system") : m.sender_email}</span>
          <span class="when">{fmtDateTime(m.msg_date)}</span>
        </div>
        {#if !m.is_internal_note && msgRecipCount(m) > 0}
          {@const rp = msgRecips(m)}
          <div class="msg-recip">
            {#if openRecips[m.id]}
              <div class="recip-lines">
                <span><b>To:</b> {rp.to.join(", ") || "—"}</span>
                {#if rp.cc.length}<span><b>Cc:</b> {rp.cc.join(", ")}</span>{/if}
              </div>
              <button type="button" class="recip-toggle" onclick={() => toggleRecips(m.id)}>hide</button>
            {:else}
              <button type="button" class="recip-toggle" onclick={() => toggleRecips(m.id)}>
                to {msgRecipCount(m)}{m.sender_email && m.sender_email !== inboxEmail ? " · " : ""}{#if rp.cc.length}(+{rp.cc.length} cc){/if}
              </button>
            {/if}
          </div>
        {/if}
        {#if m.body_html && (!m.is_internal_note || !m.body_html.startsWith("<p><strong>Internal note"))}
          <!-- svelte-ignore a11y_no_raw_html -->
          <div class="html-body">{@html sanitizeHtml(m.body_html)}</div>
        {:else}
          <div class="text-body">{m.body_plain}</div>
        {/if}
        {#if !m.is_internal_note && m.attachments && m.attachments.length}
          <div class="msg-attach">
            {#each m.attachments as fname, fi (fname)}
              {@const meta = (Array.isArray(m.attachments_meta) && m.attachments_meta[fi]) || {}}
              <a
                class="attach-chip"
                href={`${api.PB_URL}/api/files/${m.collectionId}/${m.id}/${encodeURIComponent(fname)}`}
                target="_blank"
                rel="noopener noreferrer"
                title={meta.name || fname}
              >📎 {meta.name || fname}{meta.size ? ` (${fmtBytes(meta.size)})` : ""}</a>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
  </div>

  <footer class="tv-composer" class:collapsed={tab === "conversation" && !composerOpen}>
    {#if tab === "conversation"}
      {#if !composerOpen}
        <!-- Collapsed by default: reading a thread is the common case, and the
             open editor costs ~265px of the panel below the conversation. -->
        <div class="composer-bar">
          <span class="cb-to">Reply to <strong>{thread.customer_email || "—"}</strong></span>
          <span class="spacer"></span>
          <button class="send-btn" onclick={openComposer} disabled={!!lock}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            Reply
          </button>
        </div>
      {:else}
      <div class="composer-col">
        <div class="composer-top">
          <div class="send-recip">
            <div class="sr-mode" role="group" aria-label="Reply mode">
              <button type="button" class="sr-btn" class:on={replyMode === "reply"} onclick={() => setReplyMode("reply")}>Reply</button>
              {#if canReplyAll}
                <button type="button" class="sr-btn" class:on={replyMode === "replyAll"} onclick={() => setReplyMode("replyAll")} title="Reply to everyone on the last message">Reply all</button>
              {/if}
            </div>
            {#if replyMode === "replyAll" && ccList.length}
              <div class="sr-cc">
                <span class="sr-cc-label">Cc:</span>
                {#each ccList as c (c)}
                  <span class="cc-chip">
                    {c}
                    <button type="button" title="Remove" onclick={() => removeCc(c)}>✕</button>
                  </span>
                {/each}
              </div>
            {/if}
          </div>
          {#if replyMode === "replyAll"}
            <div class="sr-addcc">
              <input type="text" placeholder="add cc…" bind:value={newCc} onkeydown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addCc(); } }} />
              <button type="button" class="md3-btn tonal small" onclick={addCc}>+</button>
            </div>
          {/if}
        </div>
        <div class="rich-wrap" class:disabled={!!lock}>
          <div class="rich-toolbar" contenteditable="false">
            <button type="button" title="Bold" disabled={!!lock} onclick={() => exec("bold")}><b>B</b></button>
            <button type="button" title="Italic" disabled={!!lock} onclick={() => exec("italic")}><i>I</i></button>
            <button type="button" title="Underline" disabled={!!lock} onclick={() => exec("underline")}><u>U</u></button>
            <button type="button" title="Strikethrough" disabled={!!lock} onclick={() => exec("strikeThrough")}><s>S</s></button>
            <span class="sep"></span>
            <button type="button" title="Bulleted list" disabled={!!lock} onclick={() => exec("insertUnorderedList")}>•≡</button>
            <button type="button" title="Numbered list" disabled={!!lock} onclick={() => exec("insertOrderedList")}>1≡</button>
            <button type="button" title="Quote" disabled={!!lock} onclick={() => exec("formatBlock", "blockquote")}>❝</button>
            <span class="sep"></span>
            <button type="button" title="Insert link" disabled={!!lock} onclick={addLink}>🔗</button>
            <button type="button" title="Clear formatting" disabled={!!lock} onclick={() => exec("removeFormat")}>✕</button>
            <button type="button" class="attach-btn" title="Attach files" disabled={!!lock} onclick={() => attachInput && attachInput.click()}>📎</button>
            <input type="file" multiple hidden bind:this={attachInput} onchange={onFilesPicked} />
            {#if mySignature()}
              <button type="button" title="Insert signature" disabled={!!lock} onclick={insertSignature}>✍️</button>
            {/if}
            <span class="spacer"></span>
            <span class="hint">{lock ? `Locked — ${lock.agentName} is composing` : "Reply to " + (thread.customer_email || "customer")}</span>
          </div>
          <div class="ed-rel">
            {#if slash}
              <div class="slash-wrap">
                {#if slashItems.length}
                  <ul class="slash-menu" role="listbox" aria-label="Saved responses" bind:this={slashListEl}>
                    {#each slashItems as c, i (c.id)}
                      <li
                        role="option"
                        aria-selected={i === slashIdx}
                        class:sel={i === slashIdx}
                        data-slash-item={i}
                        onmousedown={(ev) => {
                          ev.preventDefault();
                          pickCanned(c);
                        }}
                        onmouseenter={() => (slashIdx = i)}
                      >
                        <span class="sl-mark">/</span>
                        <span class="sl-title">{@html hl(c.title, slash.query)}</span>
                        <span class="sl-prev">{@html hl(c.body.replace(/\s+/g, " ").trim().slice(0, 70), slash.query)}</span>
                      </li>
                    {/each}
                  </ul>
                  <div class="slash-foot">
                    <span>
                      {slashItems.length}{slashHidden ? ` of ${slashMatches.length}` : ""}
                      response{slashMatches.length === 1 ? "" : "s"}
                    </span>
                    <span class="sf-keys"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close</span>
                  </div>
                {:else}
                  <div class="slash-empty">
                    No saved response matches “{slash.query}”
                  </div>
                {/if}
              </div>
            {/if}
            <div
              class="rich-body"
              contenteditable={!lock}
              role="textbox"
              aria-multiline="true"
              bind:this={editorEl}
              oninput={onEditorInput}
              onkeydown={onEditorKeydown}
              onfocus={() => (focused = true)}
              onblur={() => (focused = false)}
            ></div>
          </div>
          {#if attachments.length}
            <div class="attach-list">
              {#each attachments as a, i (a.name + a.size)}
                <span class="attach-chip">
                  📎 {a.name} <small>({fmtBytes(a.size)})</small>
                  <button type="button" title="Remove" onclick={() => removeAttachment(i)}>✕</button>
                </span>
              {/each}
            </div>
          {/if}
          <div class="rich-footer">
            <span class="rf-to">To: {thread.customer_email || "—"}{#if replyMode === "replyAll" && ccList.length} · cc {ccList.length}{/if}</span>
            <span class="spacer"></span>
            <button class="send-btn" onclick={sendReply} disabled={busySend || lock || (attachments.length === 0 && !replyText.trim())}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              Send
            </button>
          </div>
        </div>
      </div>
      {/if}
    {:else}
      <div class="note-editor">
        {#if mentionItems.length}
          <ul class="mention-menu" role="listbox">
            {#each mentionItems as u, i (u.id)}
              <li
                role="option"
                class:sel={i === mentionIdx}
                onmousedown={(ev) => {
                  ev.preventDefault();
                  pickMention(u);
                }}
                onmouseenter={() => (mentionIdx = i)}
              >
                <span class="m-avatar" style="background:{avatarColor(u.email || u.name)}">{agentInitials(u.name || u.email)}</span>
                <span class="m-name">{u.name || "—"}</span>
                <span class="m-mail">{u.email}</span>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="rich-toolbar" contenteditable="false">
          <button type="button" title="Bold" onclick={() => execNote("bold")}><b>B</b></button>
          <button type="button" title="Italic" onclick={() => execNote("italic")}><i>I</i></button>
          <button type="button" title="Underline" onclick={() => execNote("underline")}><u>U</u></button>
          <button type="button" title="Strikethrough" onclick={() => execNote("strikeThrough")}><s>S</s></button>
          <span class="sep"></span>
          <button type="button" title="Bulleted list" onclick={() => execNote("insertUnorderedList")}>•≡</button>
          <button type="button" title="Numbered list" onclick={() => execNote("insertOrderedList")}>1≡</button>
          <button type="button" title="Quote" onclick={() => execNote("formatBlock", "blockquote")}>❝</button>
          <span class="sep"></span>
          <button type="button" title="Insert link" onclick={addNoteLink}>🔗</button>
          <button type="button" title="Clear formatting" onclick={() => execNote("removeFormat")}>✕</button>
          <span class="spacer"></span>
          <span class="hint">@ to mention a teammate</span>
        </div>
        <div
          class="rich-body note-rich"
          contenteditable
          role="textbox"
          aria-multiline="true"
          data-placeholder="Add an internal note… (type @ to mention a teammate)"
          bind:this={noteEditorEl}
          oninput={onNoteEditorInput}
          onkeydown={onNoteEditorKeydown}
          onfocus={() => (noteFocused = true)}
          onblur={() => {
            noteFocused = false;
            // allow click on the menu to land before closing
            setTimeout(() => mention && (mention = null), 120);
          }}
        ></div>
      </div>
      <button class="md3-btn tonal" onclick={submitNote} disabled={busyNote || !noteText.trim()}>
        Add note
      </button>
    {/if}
  </footer>
  </div>
{/if}

{#if contactOpen && thread?.customer_email}
  <ContactPanel email={thread.customer_email} inboxId={thread.inbox} onClose={() => (contactOpen = false)} />
{/if}

<style>
  .tv-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .tv-head {
    flex: 0 0 auto;
    padding: 10px 16px 8px;
    border-bottom: 1px solid var(--m3-outline-variant);
  }

  /* The header is fixed-height above a scrolling body, so its height is
     message-space budget. Cap the subject at two lines: a long subject used to
     push the whole conversation down. */
  .head-details {
    margin-top: 10px;
    padding: 0;
  }

  .tv-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .tv-title {
    flex: 1;
    min-width: 0;
  }

  .tv-title h3 {
    font: var(--m3-type-title-lg);
    line-height: 1.3;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .cust {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
  }

  .tv-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px 0;
  }

  /* collapsible detail row (prev tickets + labels) */
  .detail-row {
    padding: 8px 16px 0;
  }

  .detail-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-md);
    font-weight: 600;
    cursor: pointer;
  }
  .detail-toggle:hover {
    color: var(--m3-on-surface);
  }
  .chev {
    transition: transform 0.15s ease;
    color: var(--m3-on-surface-variant);
  }
  .chev.open {
    transform: rotate(180deg);
  }

  .detail-body {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .dt-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dt-label {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    color: var(--m3-on-surface-variant-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .dt-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dt-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--m3-surface-container-high);
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dt-chip:hover {
    background: var(--m3-row-hover);
  }
  .dt-chip.plain {
    font-weight: 600;
  }
  .dt-status {
    font-weight: 600;
    flex: 0 0 auto;
  }

  .prev-tickets {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 16px 0;
  }

  .pt-label {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    color: var(--m3-on-surface-variant);
  }

  .pt-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 200px;
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--m3-surface-container-high);
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pt-chip:hover {
    background: var(--m3-row-hover);
  }

  .pt-status {
    font-weight: 600;
    flex: 0 0 auto;
  }

  .tgtag {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 10px;
  }

  .assignee-sel {
    border: 1px solid var(--m3-outline-variant);
    border-radius: 999px;
    background: var(--m3-surface-container-high);
    padding: 6px 10px;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
    outline: none;
  }

  .lbl-wrap {
    position: relative;
  }

  .lbl-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 60;
    min-width: 200px;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-3);
    padding: 6px;
  }

  .lbl-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 6px;
    font: var(--m3-type-body-md);
    cursor: pointer;
  }

  .lbl-item:hover {
    background: var(--m3-row-hover);
  }

  .lbl-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .lbl-new {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--m3-outline-variant);
  }

  .lbl-new input {
    flex: 1;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 4px 8px;
    font: var(--m3-type-body-sm);
    background: var(--m3-surface-container-lowest);
    min-width: 0;
  }

  .status-select {
    appearance: none;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
    background: var(--m3-surface-container-high);
    padding: 7px 12px 7px 22px;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
    background-image: radial-gradient(circle at 10px 50%, var(--sc, #888) 5px, transparent 6px);
    background-repeat: no-repeat;
    outline: none;
  }

  .tv-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }

  /* "Details" toggle now lives in the action bar, not on its own row. */
  .tv-actions .detail-toggle {
    flex: 0 0 auto;
    margin-left: 2px;
  }

  .tv-actions .spacer {
    flex: 1;
  }

  .lock-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 16px 0;
    padding: 10px 14px;
    border-radius: var(--m3-shape-sm);
    background: var(--m3-tertiary-container);
    color: var(--m3-on-tertiary-container);
    font: var(--m3-type-body-md);
  }

  /* Unread-notes count inside the Internal notes tab. Uses the same violet as
     the row/card badge, so the number on the tab is obviously the same thing the
     list badge was counting. */
  .tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    margin-left: 5px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--m3-tertiary);
    color: var(--m3-on-tertiary);
    font: var(--m3-type-label-sm);
    font-weight: 700;
    line-height: 16px;
  }

  .csat-strip {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 10px 16px 0;
    padding: 9px 14px;
    border-radius: var(--m3-shape-sm);
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    font: var(--m3-type-body-md);
  }
  .csat-strip > svg { flex: 0 0 auto; margin-top: 2px; color: #f9ab00; }
  .csat-items { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .csat-item { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .csat-stars { color: var(--m3-outline); letter-spacing: 2px; }
  .csat-stars span.lit { color: #f9ab00; }
  .csat-comment-txt { font-style: italic; font-size: 0.9rem; }
  .csat-item .link-btn {
    color: var(--m3-primary);
    text-decoration: underline;
    font-size: 0.8rem;
  }

  .tv-presence {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 16px 0;
  }

  .pv-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    font: var(--m3-type-label-sm);
  }

  .pv-name {
    font-weight: 600;
  }

  .meet-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    /* Was `var(--m3-scrim)` — a solid black backdrop, so opening this dialog
       blanked the entire app instead of dimming it. */
    background: var(--m3-scrim-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
  }

  .meet-modal {
    width: min(680px, 96vw);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    background: var(--m3-surface-container-low);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-lg);
    box-shadow: var(--m3-elev-4);
    overflow: hidden;
  }

  .mm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--m3-outline-variant);
  }

  .mm-head h3 {
    font: var(--m3-type-title-md);
  }

  .mm-linked {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 10px 16px 0;
    padding: 8px 12px;
    border-radius: var(--m3-shape-sm);
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    font: var(--m3-type-body-sm);
  }

  .mm-scroll {
    padding: 12px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .mm-days {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mm-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 58px;
    padding: 7px 8px;
    border-radius: var(--m3-shape-md);
    color: var(--m3-on-surface-variant);
    border: 1px solid transparent;
  }

  .mm-day.on {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
    font-weight: 600;
  }

  .mm-dw {
    font: var(--m3-type-label-sm);
    text-transform: uppercase;
  }
  .mm-dn {
    font: var(--m3-type-title-lg);
    font-weight: 700;
  }
  .mm-dm {
    font: var(--m3-type-label-sm);
  }

  .mm-grid {
    display: grid;
    /* Wide enough for a full "08:00 AM" label plus its padding. At 74px the
       label is wider than the cell's content box, so it ate the padding and
       touched the borders. */
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 6px;
    /* `start`, not the default `stretch`: without it the auto rows stretch to
       fill min-height, so a 60-minute day (2 rows) rendered 79px-tall cells
       while a 15-minute day (6 rows) rendered 39px ones. */
    align-content: start;
    /* Height is tuned to whole rows (34px cell + 6px gap = 40px) so a scroll
       never stops mid-row — 200px shows exactly 5 rows in the 196px content
       box. No min-height: the grid is content-sized, because reserving room for
       rows that don't exist left a large blank block under the last row at 60m
       (2 rows) that read as a rendering fault. The modal resizing between
       durations is the lesser evil. */
    max-height: 200px;
    overflow-y: auto;
    padding: 2px;
  }

  .mm-cell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    /* Uniform height regardless of how many rows the duration produces. */
    height: 34px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 0 6px;
    background: var(--m3-surface-container-lowest);
    color: var(--m3-on-surface);
    font: var(--m3-type-label-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .mm-t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mm-cell:hover:not(:disabled) {
    background: var(--m3-primary-container);
  }

  .mm-cell.busy,
  .mm-cell.past {
    background: repeating-linear-gradient(-45deg, var(--m3-surface-container-high), var(--m3-surface-container-high) 5px, var(--m3-surface-container) 5px, var(--m3-surface-container) 10px);
    color: var(--m3-on-surface-variant-2);
    text-decoration: line-through;
    cursor: not-allowed;
    opacity: 0.7;
  }

  /* `.sel:hover` is required, not tidiness: `.mm-cell:hover:not(:disabled)` scores
     0,3,0 and would otherwise beat `.mm-cell.sel` at 0,2,0 — so hovering the
     chosen slot repainted it primary-container while keeping the white text,
     i.e. the selected slot looked blank. */
  .mm-cell.sel,
  .mm-cell.sel:hover {
    background: var(--m3-primary);
    color: var(--m3-on-primary);
    border-color: var(--m3-primary);
  }

  /* The chosen slot is a single cell now, so the primary fill is the state and
     there is no second cell to mark with an outline. */

  .mm-count {
    margin-left: auto;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .mm-chosen {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    margin: -4px 0 0;
    min-height: 18px;
  }

  .mm-chosen.picked {
    color: var(--m3-on-surface);
  }

  /* .mm-grid-wrap is a plain wrapper (no styles), so without this the legend
     sat flush against the last row of slots. */
  .mm-grid-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .mm-legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .mm-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .mm-legend i {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    display: inline-block;
  }
  .lg.free {
    background: var(--m3-surface-container-lowest);
    border: 1px solid var(--m3-outline-variant);
  }
  .lg.busy {
    background: var(--m3-surface-container-high);
  }
  .lg.sel {
    background: var(--m3-primary);
  }

  .mm-dur-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mm-lbl {
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
  }

  .mm-seg {
    display: inline-flex;
    gap: 2px;
    background: var(--m3-surface-container-high);
    border-radius: 999px;
    padding: 2px;
  }

  .mm-seg button {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    color: var(--m3-on-surface-variant);
    border-radius: 999px;
    padding: 3px 10px;
  }

  .mm-seg button.on {
    background: var(--m3-primary);
    color: var(--m3-on-primary);
  }

  .mm-foot {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--m3-outline-variant);
    background: var(--m3-surface-container-lowest);
  }

  .mm-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mm-summary,
  .mm-note {
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 8px 10px;
    font: var(--m3-type-body-sm);
    background: var(--m3-surface-container-lowest);
  }

  .mm-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mm-actions .spacer {
    flex: 1;
  }

  .mm-with {
    font: var(--m3-type-label-sm);
  }

  .mm-err {
    color: var(--m3-error);
    font: var(--m3-type-label-sm);
  }

  article.flash {
    animation: notifflash 1.6s ease;
  }

  @keyframes notifflash {
    0%, 60% { background: var(--m3-tertiary-container); }
    100% { background: transparent; }
  }

  .muted {
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-body-sm);
  }

  .center {
    text-align: center;
    padding: 22px 0;
  }

  .tv-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }

  article {
    border-radius: var(--m3-shape-sm);
    padding: 10px 12px;
    max-width: 100%;
  }

  article.external {
    background: var(--m3-surface-container);
  }

  article.note {
    background: var(--m3-tertiary-container);
    color: var(--m3-on-tertiary-container);
    align-self: flex-end;
    max-width: 92%;
  }

  .msg-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .sender {
    font: var(--m3-type-label-md);
    flex: 1;
  }

  .when {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
  }

  .text-body {
    font: var(--m3-type-body-md);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .html-body :global(p) {
    margin: 0 0 8px;
  }

  .html-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: var(--m3-shape-sm);
  }

  .html-body :global(a) {
    color: var(--m3-primary);
  }

  .tv-composer {
    flex: 0 0 auto;
    display: block;
    padding: 10px 16px 12px;
    border-top: 1px solid var(--m3-outline-variant);
  }

  .tv-composer.collapsed {
    padding: 8px 16px;
  }

  /* Collapsed reply bar — a single row, restoring the vertical space the full
     editor would otherwise take while reading. */
  .composer-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .composer-bar .spacer {
    flex: 1;
  }
  .cb-to {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cb-to strong {
    color: var(--m3-on-surface);
    font-weight: 600;
  }

  .composer-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .composer-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .send-recip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .sr-mode {
    display: inline-flex;
    gap: 2px;
    background: var(--m3-surface-container);
    border-radius: var(--m3-shape-sm);
    padding: 2px;
  }

  .sr-btn {
    font: var(--m3-type-label-md);
    font-weight: 500;
    color: var(--m3-on-surface-variant);
    border-radius: 6px;
    padding: 4px 12px;
  }

  .sr-btn.on {
    background: var(--m3-primary);
    color: var(--m3-on-primary);
  }

  .sr-cc {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-width: 0;
  }

  .sr-cc-label {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .cc-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: var(--m3-type-label-sm);
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 6px;
    padding: 2px 8px;
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cc-chip button {
    color: var(--m3-on-secondary-container);
    font-size: 0.75rem;
    flex: 0 0 auto;
  }

  .sr-addcc {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .sr-addcc input {
    width: 150px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 5px 10px;
    font: var(--m3-type-label-sm);
    background: var(--m3-surface-container-lowest);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .sr-addcc input:focus {
    outline: none;
    border-color: var(--m3-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--m3-primary) 18%, transparent);
  }

  .rich-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--m3-outline-variant);
  }

  .rich-footer .rf-to {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .send-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--m3-primary);
    color: var(--m3-on-primary);
    border-radius: var(--m3-shape-sm);
    height: 36px;
    padding: 0 16px;
    font: var(--m3-type-label-lg);
    font-weight: 600;
    transition: filter 0.15s ease;
  }
  .send-btn:hover:not(:disabled) { filter: brightness(1.06); }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rich-footer .spacer {
    flex: 1;
  }

  .rich-wrap.disabled {
    opacity: 0.6;
  }

  .rich-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
    padding: 4px 6px;
    border-bottom: 1px solid var(--m3-outline-variant);
    background: var(--m3-surface-container);
    user-select: none;
  }

  .rich-toolbar button {
    min-width: 30px;
    height: 30px;
    padding: 0 7px;
    border-radius: 6px;
    color: var(--m3-on-surface-variant);
    font-size: 0.95rem;
    line-height: 1;
  }

  .rich-toolbar button:hover {
    background: var(--m3-row-hover);
  }

  .rich-toolbar button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rich-toolbar .sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--m3-outline-variant);
  }

  .rich-toolbar .spacer {
    flex: 1;
  }

  .rich-toolbar .hint {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    padding-right: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 45%;
  }

  /* Insert-link dialog. Same overlay/modal shape as .meet-*, but sized for a
     single field. Was window.prompt() — see the comment in addLink(). */
  .link-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    /* Alpha lives in the token, NOT in an `opacity` property — opacity on the
       overlay would also fade .link-modal to 35%, making the page show through
       the dialog itself. */
    background: var(--m3-scrim-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
  }

  .link-modal {
    width: min(440px, 96vw);
    background: var(--m3-surface-container-low);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-lg);
    box-shadow: var(--m3-elev-4);
    padding: 16px;
  }

  .link-modal h3 {
    font: var(--m3-type-title-md);
    margin: 0 0 4px;
  }

  .lm-sub {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    margin: 0 0 10px;
  }

  .lm-input {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid var(--m3-outline);
    border-radius: var(--m3-shape-sm);
    background: var(--m3-surface-container-lowest);
    color: var(--m3-on-surface);
    font: var(--m3-type-body-lg);
  }

  .lm-input:focus {
    outline: 2px solid var(--m3-primary);
    outline-offset: -1px;
    border-color: var(--m3-primary);
  }

  .lm-input[aria-invalid="true"] {
    border-color: var(--m3-error);
  }

  .lm-err {
    font: var(--m3-type-body-sm);
    color: var(--m3-error);
    margin: 6px 0 0;
  }

  .lm-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }

  .lm-hint {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
  }

  .rich-body {
    min-height: 108px;
    max-height: 260px;
    overflow-y: auto;
    padding: 10px 12px;
    outline: none;
    font: var(--m3-type-body-lg);
    font-size: 16px;
    line-height: 1.55;
    color: var(--m3-on-surface);
  }

  .ed-rel {
    position: relative;
  }

  /* One positioned wrapper holds the scrollable list AND the footer, so the
     count/key hints stay pinned under the list instead of scrolling with it. */
  .slash-wrap {
    position: absolute;
    top: 4px;
    left: 8px;
    right: 8px;
    z-index: 70;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-3);
    overflow: hidden;
  }

  .slash-menu {
    list-style: none;
    margin: 0;
    /* Roughly six rows visible, then it scrolls. Deliberately shorter than
       before so a long catalog is obviously scrollable rather than looking like
       the whole list. */
    max-height: 224px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px;
  }

  .slash-menu::-webkit-scrollbar {
    width: 10px;
  }
  .slash-menu::-webkit-scrollbar-thumb {
    background: var(--m3-outline);
    border-radius: 999px;
    border: 3px solid var(--m3-surface-container-high);
  }

  .slash-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 10px;
    border-top: 1px solid var(--m3-outline-variant);
    color: var(--m3-on-surface-variant-2);
    font: var(--m3-type-body-sm);
  }

  .sf-keys {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .slash-menu :global(mark) {
    background: color-mix(in srgb, var(--m3-primary) 26%, transparent);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
  }

  .slash-foot kbd {
    font: var(--m3-type-body-sm);
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: 4px;
    padding: 0 4px;
    color: var(--m3-on-surface-variant);
  }

  .slash-empty {
    padding: 12px 10px;
    color: var(--m3-on-surface-variant-2);
    font: var(--m3-type-body-sm);
    text-align: center;
  }

  .slash-menu li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
  }

  .slash-menu li.sel {
    background: var(--m3-primary-container);
  }

  .sl-mark {
    font: var(--m3-type-title-sm);
    color: var(--m3-primary);
    font-weight: 700;
    flex: 0 0 auto;
  }

  .sl-title {
    font: var(--m3-type-body-md);
    font-weight: 600;
    color: var(--m3-on-surface);
    flex: 0 0 auto;
  }

  .sl-prev {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .note-rich {
    min-height: 84px;
    font-size: 15px;
  }

  .note-editor {
    position: relative;
    flex: 1;
    min-width: 0;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    background: var(--m3-surface-container-lowest);
    overflow: visible;
  }

  .note-editor:focus-within {
    border-color: var(--m3-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--m3-primary) 18%, transparent);
  }

  .mention-menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    margin: 0 0 4px;
    list-style: none;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-3);
    max-height: 220px;
    overflow-y: auto;
    z-index: 60;
    padding: 4px;
  }

  .mention-menu li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
  }

  .mention-menu li.sel {
    background: var(--m3-primary-container);
  }

  .mention-menu .m-avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }

  .mention-menu .m-name {
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
    flex: 0 0 auto;
  }

  .mention-menu .m-mail {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rich-body:empty::before {
    content: attr(data-placeholder);
    color: var(--m3-on-surface-variant-2);
    pointer-events: none;
  }

  .attach-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 8px 8px;
    border-top: 1px solid var(--m3-outline-variant);
  }

  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--m3-surface-container-high);
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attach-chip small {
    color: var(--m3-on-surface-variant-2);
  }

  .attach-chip button {
    color: var(--m3-on-surface-variant);
    font-size: 0.8rem;
    padding: 0 2px;
    border-radius: 50%;
  }

  .attach-chip button:hover {
    background: var(--m3-row-hover);
  }

  .msg-attach {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .msg-attach .attach-chip {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
    text-decoration: none;
  }

  .close {
    flex: 0 0 auto;
    margin-top: 2px;
  }

  /* ---- message recipients + reply-all composer ---- */
  .msg-recip {
    margin: 0 0 6px;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .recip-toggle {
    color: var(--m3-primary);
    padding: 2px 7px;
    border-radius: 6px;
    font: var(--m3-type-label-sm);
    font-weight: 600;
  }

  .recip-toggle:hover {
    background: var(--m3-row-hover);
  }

  .recip-lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recip-lines span {
    overflow-wrap: anywhere;
  }

  @media (max-width: 720px) {
    .tv-head {
      padding: 8px 10px 6px;
    }
    .tv-title h3 {
      font-size: 1.05rem;
      line-height: 1.25;
    }
    .status-select,
    .assignee-sel {
      font-size: 0.8rem;
      padding: 4px 8px 4px 18px;
    }
    .tv-actions {
      gap: 4px;
      margin-top: 6px;
    }
    .tv-actions .md3-chip,
    .tv-actions .md3-btn {
      font-size: 0.78rem;
      padding: 4px 8px;
    }
    .tv-tags {
      padding: 6px 10px 0;
      gap: 4px;
    }
    .tgtag {
      font-size: 0.7rem;
      padding: 1px 7px;
    }
    .tv-presence {
      padding: 6px 10px 0;
    }
    .pv-chip {
      padding: 2px 7px;
      font-size: 0.72rem;
    }
    .tv-body {
      padding: 8px 10px;
      gap: 8px;
    }
    article {
      padding: 8px 9px;
    }
    .tv-composer {
      padding: 8px 10px 10px;
    }
    .composer-top {
      align-items: flex-start;
      flex-direction: column;
    }
    .sr-addcc {
      width: 100%;
    }
    .sr-addcc input {
      flex: 1;
    }
    .rich-toolbar .hint {
      display: none;
    }
    .rich-toolbar button {
      min-width: 26px;
      height: 27px;
    }
  }
</style>
