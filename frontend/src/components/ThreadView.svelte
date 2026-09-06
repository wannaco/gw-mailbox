<script>
  import { appState, toast, statusMeta, composingLock, agentInitials, STATUSES } from "../lib/appState.svelte.js";
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
  let slots = $state([]);
  let loadingSlots = $state(false);
  let slotMsg = $state("");

  const messages = $derived(appState.messages[threadId] || []);
  const lock = $derived(composingLock(threadId));
  const isComposing = $derived(replyText.trim().length > 0 || attachments.length > 0 || focused);

  const msgsVisible = $derived(
    tab === "conversation"
      ? messages.filter((m) => !m.is_internal_note)
      : messages.filter((m) => m.is_internal_note)
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
      await api.fetchMessages(threadId); // show the sent message immediately
    } catch (e) {
      toast("error", "Send failed: " + (e?.message || ""));
    } finally {
      busySend = false;
    }
  }

  async function submitNote() {
    const text = noteText.trim();
    if (!text || busyNote) return;
    busyNote = true;
    try {
      await api.addNote(threadId, text);
      toast("success", "Internal note added");
      noteText = "";
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

  async function loadSlots() {
    meetOpen = !meetOpen;
    if (!meetOpen) return;
    slots = [];
    slotMsg = "";
    loadingSlots = true;
    try {
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start.getTime() + 9 * 60 * 60 * 1000);
      const res = await api.availability(threadId, isoLocalInput(start), isoLocalInput(end), 30);
      slots = (res.suggestedSlots || []).slice(0, 8);
      if (!slots.length) slotMsg = "No free 30-min slots tomorrow in 09:00–18:00.";
    } catch (e) {
      slotMsg = e?.message || "Calendar unavailable (Google credentials?).";
    } finally {
      loadingSlots = false;
    }
  }

  async function book(slot) {
    try {
      const res = await api.bookMeet(threadId, {
        start: slot.start,
        end: slot.end,
        summary: thread.subject || "Support meeting"
      });
      toast("success", "Meet booked — " + (res.hangoutLink || "check the note"));
      meetOpen = false;
    } catch (e) {
      toast("error", "Booking failed: " + (e?.message || ""));
    }
  }
</script>

{#if thread}
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

    <div class="tv-actions">
      <button class="md3-chip" class:is-active={tab === "conversation"} onclick={() => (tab = "conversation")}>
        Conversation ({msgsVisible.length})
      </button>
      <button class="md3-chip" class:is-active={tab === "notes"} onclick={() => (tab = "notes")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm12-2h4v10a1 1 0 0 1-1 1h-3v-2h2v-7h-2z"/></svg>
        Internal notes
      </button>
      <div class="spacer"></div>
      <button class="md3-btn tonal small" onclick={loadSlots} disabled={!!lock}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 10.5 21 7v10l-6-3.5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v4.5z"/></svg>
        Book Meet
      </button>
    </div>
  </header>

  {#if lock}
    <div class="lock-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      <span><strong>{lock.agentName}</strong> is drafting a reply — composing is locked.</span>
    </div>
  {/if}

  {#if meetOpen}
    <div class="meet-panel">
      <h4>Book a Google Meet</h4>
      {#if loadingSlots}
        <p class="muted">Checking availability…</p>
      {:else if slotMsg}
        <p class="muted">{slotMsg}</p>
      {:else}
        <p class="muted">Free 30-min slots tomorrow (inbox calendar):</p>
        <div class="slots">
          {#each slots as s (s.start)}
            <button class="md3-chip" onclick={() => book(s)}>
              {new Date(s.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} → {new Date(s.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="tv-body">
    {#if !msgsVisible.length}
      <p class="muted center">{tab === "notes" ? "No internal notes yet." : "No messages yet."}</p>
    {/if}
    {#each msgsVisible as m (m.id)}
      <article class:note={m.is_internal_note} class:external={!m.is_internal_note}>
        <div class="msg-head">
          <span class="avatar" style="background:{avatarColor(m.sender_email)}">
            {agentInitials(m.sender_email)}
          </span>
          <span class="sender">{m.is_internal_note ? "Internal note · " + (m.sender_email || "system") : m.sender_email}</span>
          <span class="when">{fmtDateTime(m.created)}</span>
        </div>
        {#if m.body_html && !m.is_internal_note}
          <!-- svelte-ignore a11y_no_raw_html -->
          <div class="html-body">{@html sanitizeHtml(m.body_html)}</div>
        {:else if !m.is_internal_note}
          <div class="text-body">{m.body_plain}</div>
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
        <div
          class="rich-body"
          contenteditable={!lock}
          role="textbox"
          aria-multiline="true"
          bind:this={editorEl}
          oninput={onEditorInput}
          onfocus={() => (focused = true)}
          onblur={() => (focused = false)}
        ></div>
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
      </div>
      <button class="md3-btn primary" onclick={sendReply} disabled={busySend || lock || (attachments.length === 0 && !replyText.trim())}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        Send
      </button>
    {:else}
      <textarea bind:value={noteText} rows="2" placeholder="Add an internal note (@mention a teammate)…"></textarea>
      <button class="md3-btn tonal" onclick={submitNote} disabled={busyNote || !noteText.trim()}>
        Add note
      </button>
    {/if}
  </footer>
{/if}

<style>
  .tv-head {
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

  .meet-panel {
    margin: 10px 16px 0;
    padding: 12px 14px;
    border-radius: var(--m3-shape-md);
    background: var(--m3-surface-container-high);
  }

  .meet-panel h4 {
    font: var(--m3-type-title-sm);
    margin-bottom: 6px;
  }

  .muted {
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-body-sm);
  }

  .center {
    text-align: center;
    padding: 22px 0;
  }

  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
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
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 10px 16px;
    border-top: 1px solid var(--m3-outline-variant);
  }

  .rich-wrap {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    background: var(--m3-surface-container-lowest);
    overflow: hidden;
  }

  .rich-wrap:focus-within {
    border: 2px solid var(--m3-primary);
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
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px;
    color: var(--m3-on-surface-variant);
    font-size: 0.85rem;
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
    min-height: 64px;
    max-height: 240px;
    overflow-y: auto;
    padding: 8px 10px;
    outline: none;
    font: var(--m3-type-body-md);
    line-height: 1.5;
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
</style>
