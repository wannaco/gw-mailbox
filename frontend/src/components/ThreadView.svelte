<script>
  import { appState, toast, statusMeta, composingLock, agentInitials, userName, STATUSES, markThreadRead } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";
  import { timeAgo, fmtDateTime, sanitizeHtml, isoLocalInput, avatarColor } from "../lib/utils.js";

  let { threadId } = $props();

  const thread = $derived(appState.threads[threadId]);

  let tab = $state("conversation"); // conversation | notes
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

  // ---- message ordering -------------------------------------------------------
  function msgEpoch(m) {
    const s = String(m.msg_date || "").trim();
    if (!s) return 0;
    const t = new Date(s.includes("T") ? s : s.replace(" ", "T")).getTime();
    return Number.isFinite(t) ? t : 0;
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
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-msg-id="${CSS.escape(target)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 1800);
        }
        appState.jumpToMessage = null;
      });
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

  const slashItems = $derived(
    slash
      ? canned.filter((c) => {
          const q = (slash.query || "").toLowerCase();
          if (!q) return true;
          return (
            (c.title || "").toLowerCase().includes(q) ||
            (c.body || "").toLowerCase().includes(q)
          );
        }).slice(0, 8)
      : []
  );

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

  // Replace the /token with the canned body as rich paragraphs.
  function pickCanned(c) {
    const el = editorEl;
    const sel = window.getSelection && window.getSelection();
    if (el && sel && sel.rangeCount) {
      const caret = sel.getRangeAt(0);
      const range = caretTokenRange(caret.startContainer, caret.startOffset, "/");
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const paras = String(c.body || "")
        .split(/\n+/)
        .map((p) => "<p>" + esc(p).trim() + "</p>")
        .join("");
      try {
        document.execCommand("insertHTML", false, paras);
      } catch (_) {
        document.execCommand("insertText", false, c.body || "");
      }
    } else if (el) {
      el.innerHTML += "<p>" + esc(c.body || "").replace(/\n+/g, "</p><p>") + "</p>";
    }
    slash = null;
    replyText = editorText();
    el && el.focus();
  }

  function onEditorKeydown(ev) {
    if (!slash || !slashItems.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const len = slashItems.length;
      slashIdx = (slashIdx + (ev.key === "ArrowDown" ? 1 : -1) + len) % len;
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      pickCanned(slashItems[slashIdx]);
    } else if (ev.key === "Escape") {
      slash = null;
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
  function addLink() {
    const url = window.prompt("Link URL (https://...)");
    if (url) exec("createLink", url);
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
  async function sendReply() {
    const text = editorText().trim();
    const html = editorHtml();
    const hasAtt = attachments.length > 0;
    if ((!text && !html.replace(/<[^>]*>/g, "").trim() && !hasAtt) || busySend || lock) return;
    busySend = true;
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
      ccList = [];
      replyMode = "reply";
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
    const url = window.prompt("Link URL (https://...)");
    if (url) execNote("createLink", url);
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
  const assigneeOptions = $derived(Object.values(appState.users).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)));

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
  const CELL_START = 8 * 60; // 08:00
  const CELL_END = 19 * 60; // 19:00
  const CELL_STEP = 30;

  function dayStart(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function dayCells(d) {
    const out = [];
    const base = dayStart(d).getTime();
    for (let m = CELL_START; m < CELL_END; m += CELL_STEP) out.push(new Date(base + m * 60000));
    return out;
  }

  function cellBusy(d) {
    const s = d.getTime();
    const e = s + CELL_STEP * 60000;
    return busyList.some((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s);
  }
  function cellPast(d) {
    return d.getTime() < Date.now() - 60000;
  }
  function inSelection(d) {
    if (!selStart) return false;
    const s = selStart.getTime();
    const e = s + meetDur * 60000;
    const t = d.getTime();
    return t >= s && t < e;
  }

  const selectedDay = $derived(meetDays[meetIdx]);
  const selectedCells = $derived(selectedDay ? dayCells(selectedDay) : []);

  function fmtDayLabel(d, withYear) {
    return d.toLocaleDateString([], withYear
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "short", day: "numeric" });
  }
  function fmtCellTime(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  // Change duration: keep the selection anchored at its start, but if the new
  // length pushes past a busy cell / the day's end, clear it so the agent picks
  // a fresh slot (never silently book over something).
  function setDuration(d) {
    meetDur = d;
    meetErr = "";
    if (selStart) {
      const s = selStart.getTime();
      const e = s + d * 60000;
      const dayEnd = dayStart(selectedDay).getTime() + CELL_END * 60000;
      const clashes = busyList.some(
        (b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s
      );
      if (clashes || e > dayEnd) {
        selStart = null; // make them re-pick
      }
    }
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
        </span>
      </div>
      <select class="status-select" value={thread.status} onchange={setStatus}
        style="--sc:{statusMeta(thread.status).dot}">
        {#each STATUSES as s (s.value)}
          <option value={s.value}>{s.label}</option>
        {/each}
      </select>
    </div>

    {#if threadTags.length}
      <div class="tv-tags">
        {#each threadTags as tg (tg)}
          <span class="tgtag" style="background:{tagColor(tg)}22;color:{tagColor(tg)}">{tg}</span>
        {/each}
      </div>
    {/if}

    <div class="tv-actions">
      <select class="assignee-sel" value={thread.assigned_agent || ""} onchange={(e) => setAssignee(e.target.value)} disabled={busyAssign}>
        <option value="">Unassigned</option>
        {#each assigneeOptions as u (u.id)}
          <option value={u.id}>{u.name || u.email}</option>
        {/each}
      </select>
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
      <button class="md3-chip" class:is-active={tab === "conversation"} onclick={() => (tab = "conversation")}>
        Conversation ({msgsVisible.length})
      </button>
      <button class="md3-chip" class:is-active={tab === "notes"} onclick={() => (tab = "notes")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm12-2h4v10a1 1 0 0 1-1 1h-3v-2h2v-7h-2z"/></svg>
        Internal notes
      </button>
      <div class="spacer"></div>
      <button class="md3-btn tonal small" onclick={openMeet} disabled={!!lock}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 10.5 21 7v10l-6-3.5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v4.5z"/></svg>
        Book Meet
      </button>
    </div>
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

            <div class="mm-grid-wrap">
              <div class="mm-grid">
                {#each selectedCells as c (c.getTime())}
                  {@const busy = cellBusy(c)}
                  {@const past = cellPast(c)}
                  {@const sel = inSelection(c)}
                  {@const selStartCell = selStart && c.getTime() === selStart.getTime()}
                  <button
                    type="button"
                    class="mm-cell"
                    class:busy={busy}
                    class:past={past}
                    class:sel={sel}
                    class:selstart={selStartCell}
                    disabled={busy || past}
                    onclick={() => clickCell(c)}
                    title={busy ? "Busy" : past ? "In the past" : fmtCellTime(c)}
                  >
                    <span class="mm-t">{fmtCellTime(c)}</span>
                    {#if sel}<span class="mm-dur">{meetDur}m</span>{/if}
                  </button>
                {/each}
              </div>
              <div class="mm-legend">
                <span><i class="lg free"></i>Free</span>
                <span><i class="lg busy"></i>Busy</span>
                <span><i class="lg sel"></i>Selected</span>
              </div>
            </div>

            <div class="mm-dur">
              <span class="mm-lbl">Duration</span>
              <div class="mm-seg" role="group">
                {#each [15, 30, 45, 60] as d (d)}
                  <button type="button" class:on={meetDur === d} onclick={() => setDuration(d)}>{d}m</button>
                {/each}
              </div>
            </div>
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

  <footer class="tv-composer">
    {#if tab === "conversation"}
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
            <span class="spacer"></span>
            <span class="hint">{lock ? `Locked — ${lock.agentName} is composing` : "Reply to " + (thread.customer_email || "customer")}</span>
          </div>
          <div class="ed-rel">
            {#if slashItems.length}
              <ul class="slash-menu" role="listbox">
                {#each slashItems as c, i (c.id)}
                  <li
                    role="option"
                    class:sel={i === slashIdx}
                    onmousedown={(ev) => {
                      ev.preventDefault();
                      pickCanned(c);
                    }}
                    onmouseenter={() => (slashIdx = i)}
                  >
                    <span class="sl-mark">/</span>
                    <span class="sl-title">{c.title}</span>
                    <span class="sl-prev">{c.body.replace(/\s+/g, " ").trim().slice(0, 60)}</span>
                  </li>
                {/each}
              </ul>
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

<style>
  .tv-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .tv-head {
    flex: 0 0 auto;
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--m3-outline-variant);
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
    margin-top: 8px;
    flex-wrap: wrap;
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
    background: var(--m3-scrim);
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
    grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
    padding: 2px;
  }

  .mm-cell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 5px 7px;
    background: var(--m3-surface-container-lowest);
    color: var(--m3-on-surface);
    font: var(--m3-type-label-sm);
    cursor: pointer;
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

  .mm-cell.sel {
    background: var(--m3-primary);
    color: var(--m3-on-primary);
    border-color: var(--m3-primary);
  }

  .mm-cell.selstart {
    outline: 2px solid var(--m3-on-primary);
    outline-offset: -2px;
  }

  .mm-dur {
    font: var(--m3-type-label-sm);
    font-weight: 700;
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

  .mm-dur-row,
  .mm-dur {
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
    border-radius: var(--m3-shape-md);
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
    background: var(--m3-surface-container-high);
    border-radius: 999px;
    padding: 2px;
  }

  .sr-btn {
    font: var(--m3-type-label-md);
    font-weight: 600;
    color: var(--m3-on-surface-variant);
    border-radius: 999px;
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
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    border-radius: 999px;
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
    border-radius: 999px;
    padding: 4px 12px;
    font: var(--m3-type-label-sm);
    background: var(--m3-surface-container-lowest);
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
    border-radius: 999px;
    padding: 7px 16px;
    font: var(--m3-type-label-lg);
    font-weight: 600;
  }

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

  .slash-menu {
    position: absolute;
    top: 4px;
    left: 8px;
    right: 8px;
    z-index: 70;
    list-style: none;
    margin: 0;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-3);
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
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
    border: 2px solid var(--m3-primary);
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
    border-radius: 999px;
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
    padding: 1px 6px;
    border-radius: 999px;
    font: var(--m3-type-label-sm);
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
