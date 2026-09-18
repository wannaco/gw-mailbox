<script>
  import { appState, statusMeta, threadUnread, threadUnreadNotes, slaOf, toast, STATUSES } from "../lib/appState.svelte.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";
  import ThreadPresence from "./ThreadPresence.svelte";
  import { agentInitials } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";

  let { open } = $props();

  // Filters: label filter (multi-select from catalog) + status filter (single)
  let labelFilter = $state(""); // '' | label name
  let statusFilter = $state(""); // '' | status value
  let lblFilterOpen = $state(false);
  let labelCatalog = $state([]); // [{name,color}]

  // Bulk selection (checkbox mode). Set semantics via array ops for reactivity.
  let selIds = $state([]); // thread ids currently checked

  // ---- pagination -----------------------------------------------------------
  // The server returns 200 rows per page. `rows` only spans what has been
  // loaded, so the toolbar count gains a "+" and the footer offers more. Before
  // this existed an agent simply could not reach conversations past row 200 —
  // they vanished from the list with no indication anything was missing.
  let loadingMore = $state(false);
  let sentinel = $state(null); // scroll marker at the end of the list

  const loadedInInbox = $derived(
    Object.values(appState.threads).filter((t) => t.inbox === appState.activeInboxId).length
  );
  const hasMore = $derived(appState.threadsTotal > loadedInInbox);

  async function loadMore() {
    if (loadingMore || appState.threadsLoadingMore) return;
    loadingMore = true;
    try {
      await api.loadMoreThreads();
    } catch (e) {
      toast("error", e?.message || "Could not load more conversations");
    } finally {
      loadingMore = false;
    }
  }

  // Auto-load when the sentinel scrolls into view. The button in the footer is
  // the reliable fallback, and the only path if IntersectionObserver is absent.
  $effect(() => {
    if (!sentinel || !hasMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "400px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  });

  async function loadCatalog() {
    try {
      const r = await api.listLabels();
      labelCatalog = (r.items || []).map((l) => ({ name: l.name, color: l.color || "" }));
    } catch { /* non-fatal */ }
  }
  $effect(() => { loadCatalog(); });

  function labelColor(name) {
    const hit = labelCatalog.find((l) => l.name === name);
    return hit ? hit.color : "#888";
  }

  // All threads in this inbox that pass the non-status filters (search, mine,
  // label) — used for counts AND as the pool for select-all.
  const base = $derived(
    Object.values(appState.threads)
      .filter((t) => t.inbox === appState.activeInboxId)
      .filter((t) => {
        if (appState.onlyMine && t.assigned_agent !== appState.me?.id) return false;
        if (labelFilter && !(Array.isArray(t.tags) ? t.tags : []).includes(labelFilter)) return false;
        if (!appState.search) return true;
        const q = appState.search.toLowerCase();
        return (
          (t.subject || "").toLowerCase().includes(q) ||
          (t.customer_email || "").toLowerCase().includes(q) ||
          (t.customer_name || "").toLowerCase().includes(q) ||
          (t.snippet || "").toLowerCase().includes(q)
        );
      })
  );

  // Status counts come from `base` (not rows) so Spam/Archived chips are
  // visible even when those buckets are hidden from the default list.
  const counts = $derived(
    base.reduce((acc, t) => {
      const s = t.status || "new";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {})
  );

  // Rows = base minus hidden buckets unless explicitly filtered to them.
  // Default view hides spam + archived (Gmail-like); chips reveal them.
  const rows = $derived(
    base
      .filter((t) => {
        if (statusFilter) return (t.status || "new") === statusFilter;
        const s = t.status || "new";
        return s !== "spam" && s !== "archived";
      })
      .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))
  );

  // Unread-ish: new + escalated threads render bold, like Gmail.
  const isHot = (t) => t.status === "new" || t.status === "escalated";
  const msgCount = (t) => t.message_count || 0;
  // Unread internal notes. Distinct badge from the message count: notes are
  // internal discussion, so an agent needs to see at a glance that a colleague
  // left a comment they have not read.
  const unreadNotes = (t) => threadUnreadNotes(t.id);
  const isUnread = (t) => threadUnread(t.id) > 0;

  const composingOf = (threadId) =>
    Object.values(appState.presence).find(
      (p) => p.thread === threadId && p.user !== appState.me?.id && p.status === "composing_reply"
    );

  const assignedName = (t) =>
    t.assigned_agent ? appState.users[t.assigned_agent]?.name || t.assigned_agent : "";

  // ---- quick actions (⋯ menu per row, no need to open the thread) ----------
  const agents = $derived(
    Object.values(appState.users)
      .filter((u) => (u.kind || 'agent') !== 'admin')
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
  );
  let qaMenu = $state(""); // threadId with the open ⋯ menu
  let qaPos = $state({ left: 0, top: 0 });

  // Position the popover fixed at the ⋯ button so it never gets clipped by the
  // list scroll container, then clamp inside the viewport.
  function openQa(id, el) {
    if (qaMenu === id) { qaMenu = ""; return; }
    if (el) {
      const r = el.getBoundingClientRect();
      const W = 260, H = 320;
      qaPos = {
        left: Math.max(8, Math.min(r.right - 8, window.innerWidth - W - 8)),
        top: Math.max(8, Math.min(r.top, window.innerHeight - H - 8))
      };
    }
    qaMenu = id;
  }
  // Close the ⋯ menu when clicking anywhere else.
  $effect(() => {
    if (!qaMenu) return;
    const h = (e) => {
      if (!(e.target && e.target.closest && e.target.closest(".qa-anchor"))) qaMenu = "";
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  });

  async function qaAssign(t, agentId) {
    const prev = t.assigned_agent;
    t.assigned_agent = agentId || ""; // optimistic
    qaMenu = "";
    try {
      await api.moveThread(t.id, t.status || "new", { assigned_agent: agentId || "" });
      toast("success", agentId ? "Assigned" : "Unassigned");
    } catch (e) {
      t.assigned_agent = prev;
      toast("error", e?.message || "Assign failed");
    }
  }

  async function qaToggleLabel(t, name) {
    const cur = Array.isArray(t.tags) ? t.tags : [];
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    t.tags = next; // optimistic
    try {
      await api.moveThread(t.id, t.status || "new", { tags: next });
    } catch (e) {
      toast("error", e?.message || "Label update failed");
    }
  }

  // ---- selection helpers ----------------------------------------------------
  const selSet = $derived(new Set(selIds));
  const allSelected = $derived(rows.length > 0 && rows.every((t) => selSet.has(t.id)));
  function toggleSel(id) {
    selIds = selSet.has(id) ? selIds.filter((x) => x !== id) : [...selIds, id];
  }
  function toggleSelectAll() {
    selIds = allSelected ? [] : rows.map((t) => t.id);
  }
  function clearSel() { selIds = []; }

  // ---- bulk actions ---------------------------------------------------------
  const ACTION_LABEL = { spam: "spam", archived: "archive", closed: "closed", delete: "deleted", new: "moved back to New" };

  // Show "Not spam" only when the selection actually contains spam. Marking spam
  // was one-way in bulk: the threads kept their status and there was no way back
  // from the list, so a mis-click was a dead end. Tying it to the selection keeps
  // the bar uncluttered while making the rescue available exactly when it applies.
  const selHasSpam = $derived(selIds.some((id) => appState.threads[id]?.status === "spam"));
  async function runBulk(action) {
    if (!selIds.length) return;
    const n = selIds.length;
    if (action === "delete" && !confirm(`Delete ${n} conversation${n === 1 ? "" : "s"} permanently? Messages and notes inside them will be removed too.`)) return;
    try {
      const res = await api.bulkThreads(selIds, action);
      const ok = res?.processed || 0;
      // Optimistic local update so THIS session reflects the change instantly
      // (even if the follow-up refetch below hiccups). Delete purges rows;
      // status moves update the cached record so list/board re-derive.
      const acted = new Set(selIds);
      if (action === "delete") {
        for (const id of acted) {
          delete appState.threads[id];
          delete appState.messages[id];
          delete appState.readCounts[id];
        }
        if (appState.openThreadId && acted.has(appState.openThreadId)) appState.openThreadId = "";
      } else {
        for (const id of acted) {
          const cur = appState.threads[id];
          if (cur) cur.status = action;
        }
      }
      await api.refreshThreads();
      selIds = [];
      toast("success", ok ? `Done — ${ok} conversation${ok === 1 ? "" : "s"} ${ACTION_LABEL[action]}` : "No changes applied");
    } catch (e) {
      toast("error", e?.message || "Bulk action failed");
    }
  }
</script>

<div class="list-wrap">
  <div class="toolbar">
    <div class="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 3a6.5 6.5 0 1 0 4.05 11.55l4.95 4.95 1.5-1.5-4.95-4.95A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>
      <input bind:value={appState.search} placeholder="Search threads… (select all matching below)" />
    </div>
    <span
      class="count"
      title={hasMore ? "More conversations available — scroll or use Load more" : ""}
    >{rows.length}{hasMore ? "+" : ""} conversation{rows.length === 1 ? "" : "s"}</span>
    <button class="md3-chip" class:is-active={appState.onlyMine} onclick={() => (appState.onlyMine = !appState.onlyMine)}>My tickets</button>
    {#each STATUSES as st (st.value)}
      {#if (counts[st.value] || 0) > 0}
        <button class="mini-chip" class:is-active={statusFilter === st.value} onclick={() => (statusFilter = statusFilter === st.value ? "" : st.value)}
          style="--dot:{st.dot}">
          <span class="dot"></span>{st.label} {counts[st.value]}
        </button>
      {/if}
    {/each}
    {#if labelCatalog.length}
      <div class="lblf-wrap">
        <button class="md3-chip" class:is-active={!!labelFilter} onclick={() => (lblFilterOpen = !lblFilterOpen)}>Label{#if labelFilter}: {labelFilter}{/if}</button>
        {#if lblFilterOpen}
          <div class="lblf-menu">
            <button class:sel={!labelFilter} onclick={() => { labelFilter = ""; lblFilterOpen = false; }}>All labels</button>
            {#each labelCatalog as lb (lb.name)}
              <button class:sel={labelFilter === lb.name} onclick={() => { labelFilter = labelFilter === lb.name ? "" : lb.name; lblFilterOpen = false; }}>
                <span class="dot" style="background:{lb.color || '#888'}"></span>{lb.name}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if selIds.length > 0}
    <div class="bulkbar">
      <label class="ck-all" title="Select all matching">
        <input type="checkbox" checked={allSelected} onchange={toggleSelectAll} />
      </label>
      <span class="bb-count"><b>{selIds.length}</b> selected</span>
      {#if !allSelected && rows.length > selIds.length}
        <button class="bb-selectall" onclick={toggleSelectAll}>Select all {rows.length} matching</button>
      {/if}
      <span class="bb-spacer"></span>
      <button class="md3-btn small" onclick={() => runBulk("closed")} disabled={selIds.length === 0}>Close</button>
      <button class="md3-btn small" onclick={() => runBulk("archived")} disabled={selIds.length === 0}>Archive</button>
      {#if selHasSpam}
        <button class="md3-btn small" onclick={() => runBulk("new")} disabled={selIds.length === 0}>Not spam</button>
      {/if}
      <button class="md3-btn small danger" onclick={() => runBulk("spam")} disabled={selIds.length === 0}>Mark spam</button>
      {#if appState.me?.isAdmin}
        <button class="md3-btn small danger solid" onclick={() => runBulk("delete")} disabled={selIds.length === 0}>Delete</button>
      {/if}
      <button class="md3-btn small tonal" onclick={clearSel}>Clear</button>
    </div>
  {/if}

  <div class="list">
    {#if !rows.length}
      <div class="empty">
        <p>No conversations{appState.search ? " match your search" : ""}.</p>
      </div>
    {/if}

    {#each rows as t (t.id)}
      {@const comp = composingOf(t.id)}
      {@const sla = slaOf(t)}
      <div class="rowline" class:sel={selSet.has(t.id)}>
        <label class="rowck" title="Select" onclick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selSet.has(t.id)} onchange={() => toggleSel(t.id)} />
        </label>
        <button
          class="row"
          class:hot={isHot(t)}
          class:unread={isUnread(t)}
          onclick={() => open(t.id)}
          aria-label={t.subject || "Thread"}
        >
          <span class="avatar" style="background:{avatarColor(t.customer_email || t.customer_name)}">
            {agentInitials(t.customer_name || t.customer_email)}
          </span>

          <span class="mid">
            <span class="top">
              {#if isUnread(t)}
                <span class="unread-dot" title="New messages"></span>
              {/if}
              <span class="subject">{t.subject || "(no subject)"}</span>
              {#if msgCount(t) > 0}
                <span class="mcount" class:unread={isUnread(t)} title={`${msgCount(t)} message${msgCount(t) === 1 ? "" : "s"}`}>{msgCount(t)}</span>
              {/if}
              {#if unreadNotes(t) > 0}
                <span
                  class="ncount"
                  title={`${unreadNotes(t)} unread internal note${unreadNotes(t) === 1 ? "" : "s"}`}
                  aria-label={`${unreadNotes(t)} unread internal notes`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm12-2h4v10a1 1 0 0 1-1 1h-3v-2h2v-7h-2z"/></svg>
                  {unreadNotes(t)}
                </span>
              {/if}
              {#each (Array.isArray(t.tags) ? t.tags : []).slice(0, 3) as tag (tag)}
                <span class="tag">{tag}</span>
              {/each}
              {#if comp}
                <span class="pencil" title={`${comp.agentName || "Someone"} is drafting a reply`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </span>
              {/if}
            </span>
            <span class="snip">
              <span class="from">{t.customer_name || t.customer_email || "—"}</span>
              <span class="snippet-text">{t.snippet || ""}</span>
              {#if assignedName(t)}
                <span class="assignee-pill" class:mine={t.assigned_agent === appState.me?.id} title={`Assigned to ${assignedName(t)}`}>
                  <span class="ap-ava" style="background:{avatarColor(t.assigned_agent)}">{agentInitials(assignedName(t))}</span>
                  <span class="ap-name">{assignedName(t)}</span>
                </span>
              {/if}
            </span>
          </span>

          <span class="right">
            <span class="right-top">
              <ThreadPresence threadId={t.id} />
              <span class="when">{timeAgo(t.last_message_at)}</span>
              <span class="status-pill" style="background:{statusMeta(t.status).dot}22;color:{statusMeta(t.status).dot}">
                {statusMeta(t.status).label}
              </span>
            </span>
            {#if sla}
              <span class="sla-chip" class:breached={sla.kind === "breached"} style="background:{sla.color}18;color:{sla.color}" title={sla.title}>
                {sla.text}
              </span>
            {/if}
          </span>
        </button>
        <span class="qa-anchor" class:open={qaMenu === t.id}>
          <button
            class="qa-dots"
            title="Quick actions"
            aria-label="Quick actions"
            aria-expanded={qaMenu === t.id}
            onclick={(e) => { e.stopPropagation(); openQa(t.id, e.currentTarget); }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
          </button>
          {#if qaMenu === t.id}
            <div class="qa-pop" style="left:{qaPos.left}px;top:{qaPos.top}px">
              <div class="qa-title">Assignee</div>
              <div class="qa-optlist">
                {#each agents as a (a.id)}
                  <button
                    type="button"
                    class="qa-opt"
                    class:on={t.assigned_agent === a.id}
                    onclick={(e) => { e.stopPropagation(); qaAssign(t, a.id); }}
                  >
                    <span class="qa-ava" style="background:{avatarColor(a.id)}">{agentInitials(a.name || a.email)}</span>
                    <span class="qa-name">{a.name || a.email}</span>
                    {#if t.assigned_agent === a.id}<span class="qa-check">✓</span>{/if}
                  </button>
                {/each}
                <button
                  type="button"
                  class="qa-opt"
                  class:on={!t.assigned_agent}
                  onclick={(e) => { e.stopPropagation(); qaAssign(t, ""); }}
                >
                  <span class="qa-name">Unassigned</span>
                  {#if !t.assigned_agent}<span class="qa-check">✓</span>{/if}
                </button>
              </div>

              <div class="qa-title">Labels</div>
              <div class="qa-optlist qa-wrap">
                {#if !labelCatalog.length}
                  <span class="muted qa-none">No labels yet</span>
                {/if}
                {#each labelCatalog as lb (lb.name)}
                  <button
                    type="button"
                    class="qa-lbl"
                    class:on={(Array.isArray(t.tags) ? t.tags : []).includes(lb.name)}
                    onclick={(e) => { e.stopPropagation(); qaToggleLabel(t, lb.name); }}
                  >
                    <span class="dot" style="background:{lb.color || '#888'}"></span>
                    {lb.name}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </span>
      </div>
    {/each}

    <!-- Pagination footer. The server pages at 200 rows, so without this the
         oldest conversations would be unreachable from the list. -->
    {#if hasMore}
      <div class="more">
        <button class="md3-btn tonal small" onclick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more conversations"}
        </button>
        <span class="more-hint">
          Showing {loadedInInbox} of {appState.threadsTotal} in this mailbox
        </span>
      </div>
    {:else if appState.threadsTotal > 0 && rows.length > 0}
      <p class="more-end">All {appState.threadsTotal} conversation{appState.threadsTotal === 1 ? "" : "s"} loaded</p>
    {/if}
    <div class="sentinel" bind:this={sentinel} aria-hidden="true"></div>
  </div>
</div>

<style>
  .list-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    /* Content stops growing past a comfortable reading width and centres in
       what's left. On a wide desktop the rows were stretching to 1400px+,
       which is what made the layout feel loose rather than crisp. */
    width: 100%;
    max-width: 1180px;
    margin: 0 auto;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px 10px;
    flex-wrap: wrap;
  }

  .search {
    flex: 1;
    min-width: 200px;
    max-width: 420px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 12px;
    background: var(--m3-surface-container-lowest);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    color: var(--m3-on-surface-variant);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search:focus-within {
    border-color: var(--m3-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--m3-primary) 18%, transparent);
  }
  .search input {
    flex: 1;
    background: none;
    border: 0;
    outline: none;
    min-width: 0;
    font-size: 0.9rem;
  }

  .count {
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface-variant-2);
    margin-right: 4px;
  }

  .more {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 22px 0 12px;
  }
  .more-hint {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
  }
  .more-end {
    margin: 0;
    padding: 20px 0 8px;
    text-align: center;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
  }
  .sentinel { height: 1px; }

  .mini-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .mini-chip .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--dot, #888);
    display: inline-block;
  }
  button.mini-chip {
    cursor: pointer;
    border-radius: 999px;
    padding: 3px 8px;
  }
  button.mini-chip.is-active {
    background: var(--m3-surface-container-high);
    outline: 1px solid var(--m3-outline-variant);
  }

  .lblf-wrap { position: relative; }
  .lblf-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 60;
    min-width: 170px;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-3);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lblf-menu button {
    display: flex;
    align-items: center;
    gap: 7px;
    text-align: left;
    padding: 5px 8px;
    border-radius: 7px;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
  }
  .lblf-menu button:hover { background: var(--m3-row-hover); }
  .lblf-menu button.sel { background: var(--m3-primary-container); }
  .lblf-menu .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }

  /* Bulk action bar */
  .bulkbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--m3-surface-container-lowest);
    color: var(--m3-on-surface);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-2);
    margin: 0 20px 10px;
    flex-wrap: wrap;
  }
  .bb-count { color: var(--m3-on-surface-variant); }
  .ck-all { display: inline-flex; align-items: center; }
  .bb-count { font: var(--m3-type-label-lg); }
  .bb-count b { font-weight: 700; }
  .bb-spacer { flex: 1; }
  button.bb-selectall {
    font: var(--m3-type-label-md);
    text-decoration: underline;
    color: inherit;
    cursor: pointer;
  }
  .bulkbar .md3-btn { padding: 4px 12px; }
  .bulkbar .md3-btn.danger.solid {
    background: #ba1a1a;
    color: #fff;
  }
  .bulkbar .md3-btn.danger:not(.solid) {
    border: 1px solid #ba1a1a;
    color: #ba1a1a;
  }

  /* The rows sit on their own surface, lifted off the page with the same
     tinted shadow family the login card uses. Same idea as the login: a panel
     separated from the background reads as designed; rows floating directly on
     a flat background read as a table. */
  .list {
    flex: 1;
    overflow-y: auto;
    margin: 0 20px 20px;
    padding: 4px 0;
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 70%, transparent);
    border-radius: var(--m3-shape-lg);
    /* A crisp 1px edge rather than an ambient lift. The larger shadow looked
       soft against a hairline-bordered card and read as blur. */
    box-shadow: 0 1px 2px rgb(15 40 80 / 0.06);
  }

  /* Rows are separated by a hairline inset from the right, not a full-bleed
     rule: the line stops short of the edge so the list reads as a stack of
     items rather than a table with gridlines. */
  /* Margin, not padding: the border-bottom is drawn at the box edge, so a
     margin is what insets the separator from the card's rounded sides. */
  /* Separator as border-TOP on every row but the first, rather than
     border-bottom on all: the bottom version also drew a line under the last
     row, which read as an unfinished list. */
  .rowline {
    display: flex;
    align-items: center;
    margin: 0 10px;
    transition: background 0.1s ease;
  }
  .rowline + .rowline {
    border-top: 1px solid color-mix(in srgb, var(--m3-outline-variant) 60%, transparent);
  }
  /* Gated on hover-capable pointers: on touch, :hover sticks after a tap, so
     the row the user last touched stayed highlighted as if it were selected. */
  @media (hover: hover) {
    .rowline:hover {
      background: var(--m3-row-hover);
    }
    .rowline:hover .when { color: var(--m3-on-surface-variant); }
  }
  .rowline.sel {
    background: var(--m3-primary-container);
  }
  .rowck {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    flex: 0 0 auto;
    cursor: pointer;
    align-self: stretch;
  }
  .rowck input {
    width: 16px;
    height: 16px;
    accent-color: var(--m3-primary);
    cursor: pointer;
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 13px;
    text-align: left;
    /* Extra left padding is where the unread accent bar sits, so it reads as
       belonging to the row rather than as a rule at the card's edge. */
    padding: 13px 14px 13px 14px;
    border: 0;
    background: none;
    cursor: pointer;
    position: relative;
  }
  .row:focus-visible {
    outline: 2px solid var(--m3-primary);
    outline-offset: -2px;
  }

  /* ---- per-row quick actions (⋯) ---- */
  .qa-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0 8px 0 2px;
    flex: 0 0 auto;
    align-self: stretch;
  }
  .qa-dots {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--m3-on-surface-variant);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .qa-dots:hover { background: var(--m3-surface-container-highest); }
  .rowline:hover .qa-dots,
  .qa-anchor.open .qa-dots,
  .qa-dots:focus-visible { opacity: 1; }
  .qa-anchor.open .qa-dots { background: var(--m3-surface-container-highest); color: var(--m3-primary); }

  /* Touch / coarse-pointer: there is no hover to reveal the ⋯, so keep the
     quick-action dots always visible (Gmail-style). */
  @media (hover: none), (pointer: coarse) {
    .qa-dots { opacity: 1; }
    .qa-dots:hover { background: transparent; }
    .rowline:hover .qa-dots { opacity: 1; }
  }

  .qa-pop {
    position: fixed;
    z-index: 90;
    width: 264px;
    max-height: min(400px, 70vh);
    overflow-y: auto;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-4);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qa-title {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--m3-on-surface-variant);
    margin: 6px 2px 2px;
  }
  .qa-optlist {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .qa-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 7px;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
    cursor: pointer;
    min-height: 30px;
  }
  .qa-opt:hover { background: var(--m3-row-hover); }
  .qa-opt.on { background: var(--m3-primary-container); }
  .qa-ava {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .qa-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-check { color: var(--m3-primary); font-weight: 700; flex: 0 0 auto; }
  .qa-wrap { flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .qa-lbl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
    border: 1px solid var(--m3-outline-variant);
    border-radius: 999px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .qa-lbl .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .qa-lbl.on { background: var(--m3-secondary-container); color: var(--m3-on-secondary-container); border-color: transparent; }
  .qa-none { font-size: 0.8rem; padding: 2px 8px; }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    flex: 0 0 auto;
    letter-spacing: 0.02em;
  }

  .mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    /* The subject takes the slack and ellipsises; badges keep their size. */
    flex-wrap: nowrap;
  }

  .subject {
    font: var(--m3-type-body-md);
    font-size: 0.9375rem;
    line-height: 1.35;
    font-weight: 400;
    color: var(--m3-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1 auto;
  }

  /* Unread reads as the primary thing on the row; read mail recedes. */
  .row.hot .subject,
  .row.unread .subject {
    font-weight: 600;
    color: var(--m3-on-surface);
  }

  /* No accent bar here. I added one and removed it: sitting between the
     checkbox and the avatar it read as a stray divider, and the row already
     carries two unread cues (the dot and the heavier subject). The bar was
     redundant AND confusing, which is worse than neither.

     The row background is deliberately left untouched by unread state so the
     hover and selected tints stay legible underneath. */

  .unread-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--m3-primary);
    flex: 0 0 auto;
  }

  .mcount {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    border: 1px solid var(--m3-outline-variant);
    border-radius: 10px;
    padding: 0 6px;
    line-height: 16px;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .mcount.unread {
    color: var(--m3-primary);
    border-color: var(--m3-primary);
    font-weight: 600;
  }

  /* Unread internal notes — a filled round badge, deliberately NOT the outlined
     pill the message count uses, and in the tertiary (internal/drafting) violet
     rather than the primary blue. Two similar blue badges side by side would be
     ambiguous; these must read as different things at a glance. */
  .ncount {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font: var(--m3-type-label-sm);
    font-weight: 700;
    color: var(--m3-on-tertiary);
    background: var(--m3-tertiary);
    border-radius: 999px;
    padding: 1px 7px;
    line-height: 16px;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .tag {
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 4px;
    padding: 1px 7px;
    font: var(--m3-type-label-sm);
    white-space: nowrap;
  }

  .pencil {
    color: var(--m3-tertiary);
    display: inline-flex;
  }

  /* Second line: who wrote, what they said, and (if any) the assignee. The
     assignee used to sit on its OWN third row, which made every assigned row
     ~30px taller than the rest — the main reason the list looked uneven. */
  .snip {
    display: flex;
    gap: 8px;
    min-width: 0;
    align-items: center;
  }

  .from {
    font: var(--m3-type-body-sm);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    flex: 0 0 auto;
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* flex:1 so it absorbs the remaining width and ellipsises, letting the
     assignee sit hard right instead of being pushed off the row. */
  .snippet-text {
    font: var(--m3-type-body-sm);
    font-size: 0.8125rem;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1 1 auto;
    min-width: 0;
  }

  .row.hot .from {
    color: var(--m3-on-surface);
  }

  .assignee-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    flex: 0 0 auto;
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 999px;
    padding: 2px 8px 2px 3px;
    font: var(--m3-type-label-sm);
    font-weight: 500;
    max-width: 34%;
    overflow: hidden;
  }
  .assignee-pill.mine {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }


  .ap-ava {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    color: #fff;
    font-size: 8px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .ap-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Two rows, not three: time and status share a line, the SLA chip sits
     under them. Three stacked items made the right column the tallest thing in
     the row and drove the row height. */
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: 0 0 auto;
  }

  .right-top {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .when {
    font: var(--m3-type-label-sm);
    font-variant-numeric: tabular-nums;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }

  .status-pill {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }

  .sla-chip {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .sla-chip.breached {
    animation: sla-pulse 1.8s ease-in-out infinite;
  }
  @keyframes sla-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  /* ---- mobile: compact stacked rows (no overlap) ---- */
  @media (max-width: 620px) {
    .list { padding: 0 8px 12px; }
    .toolbar { padding: 8px 10px 6px; gap: 6px; }
    .search { min-width: 100%; max-width: none; order: -1; }

    .rowline {
      position: relative;
      align-items: center;
    }
    .rowck { width: 26px; }
    .rowck input { width: 15px; height: 15px; }

    .row {
      flex-wrap: wrap;
      gap: 2px 8px;
      padding: 8px 34px 8px 2px; /* right room for the ⋯ overlay */
    }

    .avatar { width: 30px; height: 30px; font-size: 10px; }

    .mid { min-width: 0; }
    .top { gap: 5px; flex-wrap: wrap; }
    .subject { font-size: 0.9rem; min-width: 0; }
    .snip { gap: 4px; }
    .from { max-width: 42%; }
    .snippet-text { font-size: 0.8rem; }

    /* Status / time / SLA become their own wrapped chip row, never side-by-side
       with the sender line -> no overlap even for long statuses. */
    .right {
      order: 5;
      flex: 1 1 100%;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: wrap;
      gap: 4px 8px;
      margin-left: 40px; /* align under the text (26 checkbox + 30 avatar + gaps) */
      margin-top: 1px;
    }
    .status-pill, .sla-chip, .when { font-size: 0.72rem; }
    .sla-chip { padding: 0 7px; }
    .status-pill { padding: 0 6px; }

    /* Bump the stacked status + SLA chips a touch so they're readable, while
       leaving the relative 'when' timestamp small. */
    .status-pill, .sla-chip { font-size: 0.8rem; padding: 2px 9px; }
    .when { font-size: 0.72rem; }

    /* ⋯ anchored top-right, always visible on touch; stays out of text flow */
    .qa-anchor {
      position: absolute;
      top: 4px;
      right: 2px;
      padding: 0;
    }
    .qa-dots { width: 26px; height: 26px; opacity: 1; }

    /* assignee pill: keep on the text block, compact + ellipsized */
    .assignee-pill { max-width: 100%; }
  }

  .empty {
    text-align: center;
    color: var(--m3-on-surface-variant-2);
    padding: 48px 0;
    font: var(--m3-type-body-md);
  }
</style>
