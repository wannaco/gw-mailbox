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
      appState.labels = labelCatalog;
    } catch { /* non-fatal */ }
  }
  $effect(() => { loadCatalog(); });

  function labelColor(name) {
    const hit = labelCatalog.find((l) => l.name === name);
    return (hit && hit.color) || "#9aa0a6";
  }

  // Phones get a different row layout (sender/time first, then subject,
  // snippet, and a chip line), not the desktop row squeezed. Driven from JS
  // because the two layouts group the same fields differently, which CSS
  // alone can't reorder cleanly. Breakpoint matches the App's mobile shell.
  const MQ = "(max-width: 620px)";
  let compact = $state(typeof window !== "undefined" && window.matchMedia(MQ).matches);
  $effect(() => {
    const mq = window.matchMedia(MQ);
    const h = () => (compact = mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  });

  // Label filter menu is position:fixed because the chip row scrolls
  // horizontally on mobile, and an overflow container clips absolute children.
  let lblPos = $state({ left: 0, top: 0 });
  function toggleLblFilter(el) {
    if (!lblFilterOpen && el) {
      const r = el.getBoundingClientRect();
      lblPos = { left: Math.max(8, Math.min(r.left, window.innerWidth - 220)), top: r.bottom + 6 };
    }
    lblFilterOpen = !lblFilterOpen;
  }
  $effect(() => {
    if (!lblFilterOpen) return;
    const h = (e) => {
      if (!(e.target && e.target.closest && e.target.closest(".lblf-wrap, .lblf-menu"))) lblFilterOpen = false;
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  });

  const tagsOf = (t) => (Array.isArray(t.tags) ? t.tags : []);

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

{#snippet badges(t)}
  {#if msgCount(t) > 1}
    <span class="mcount" class:unread={isUnread(t)} title={`${msgCount(t)} messages`}>{msgCount(t)}</span>
  {/if}
  {#if unreadNotes(t) > 0}
    <span
      class="ncount"
      title={`${unreadNotes(t)} unread internal note${unreadNotes(t) === 1 ? "" : "s"}`}
      aria-label={`${unreadNotes(t)} unread internal notes`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-3 11H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
      {unreadNotes(t)}
    </span>
  {/if}
  {#if composingOf(t.id)}
    {@const comp = composingOf(t.id)}
    <span class="pencil" title={`${comp.agentName || "Someone"} is drafting a reply`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
    </span>
  {/if}
{/snippet}

{#snippet tagList(t, max)}
  {#each tagsOf(t).slice(0, max) as tag (tag)}
    <span class="tag" style="--tag:{labelColor(tag)}"><span class="tdot"></span><span class="tname">{tag}</span></span>
  {/each}
  {#if tagsOf(t).length > max}
    <span class="tag more" title={tagsOf(t).slice(max).join(", ")}>+{tagsOf(t).length - max}</span>
  {/if}
{/snippet}

{#snippet statusPill(t)}
  <span class="status-pill" style="--c:{statusMeta(t.status).dot};--ci:{statusMeta(t.status).ink}"><span class="sdot"></span>{statusMeta(t.status).label}</span>
{/snippet}

{#snippet slaChip(sla)}
  <span class="sla-chip" class:breached={sla.kind === "breached"} style="--c:{sla.color};--ci:{sla.ink}" title={sla.title}>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4V7h-2v6.2l4.6 2.8 1-1.7-3.6-1.9z"/></svg>
    {sla.text}
  </span>
{/snippet}

{#snippet assignee(t)}
  {#if assignedName(t)}
    <span class="assignee" class:mine={t.assigned_agent === appState.me?.id} title={`Assigned to ${assignedName(t)}`}>
      <span class="ap-ava" style="background:{avatarColor(t.assigned_agent)}">{agentInitials(assignedName(t))}</span>
      <span class="ap-name">{t.assigned_agent === appState.me?.id ? "You" : assignedName(t)}</span>
    </span>
  {/if}
{/snippet}

<div class="list-wrap">
  <div class="toolbar">
    <div class="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.5 3a6.5 6.5 0 1 0 4.05 11.55l4.95 4.95 1.5-1.5-4.95-4.95A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>
      <input bind:value={appState.search} placeholder="Search conversations" aria-label="Search conversations" />
      {#if appState.search}
        <button class="search-clear" aria-label="Clear search" onclick={() => (appState.search = "")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      {/if}
    </div>

    <div class="filters" role="toolbar" aria-label="Filters">
      <button class="fchip" class:is-active={appState.onlyMine} aria-pressed={appState.onlyMine} onclick={() => (appState.onlyMine = !appState.onlyMine)}>
        {#if appState.onlyMine}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
        {/if}
        My tickets
      </button>
      {#each STATUSES as st (st.value)}
        {#if (counts[st.value] || 0) > 0}
          <button
            class="fchip"
            class:is-active={statusFilter === st.value}
            aria-pressed={statusFilter === st.value}
            onclick={() => (statusFilter = statusFilter === st.value ? "" : st.value)}
            style="--dot:{st.dot}"
          >
            <span class="dot"></span>{st.label}<span class="fcount">{counts[st.value]}</span>
          </button>
        {/if}
      {/each}
      {#if labelCatalog.length}
        <span class="lblf-wrap">
          <button class="fchip" class:is-active={!!labelFilter} aria-expanded={lblFilterOpen} onclick={(e) => toggleLblFilter(e.currentTarget)}>
            {#if labelFilter}<span class="dot" style="--dot:{labelColor(labelFilter)}"></span>{/if}
            {labelFilter || "Label"}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
        </span>
      {/if}
    </div>

    <span class="count" title={hasMore ? "More conversations available — scroll or use Load more" : ""}>
      {rows.length}{hasMore ? "+" : ""} conversation{rows.length === 1 ? "" : "s"}
    </span>
  </div>

  {#if lblFilterOpen}
    <div class="lblf-menu" style="left:{lblPos.left}px;top:{lblPos.top}px">
      <button class:sel={!labelFilter} onclick={() => { labelFilter = ""; lblFilterOpen = false; }}>All labels</button>
      {#each labelCatalog as lb (lb.name)}
        <button class:sel={labelFilter === lb.name} onclick={() => { labelFilter = labelFilter === lb.name ? "" : lb.name; lblFilterOpen = false; }}>
          <span class="dot" style="background:{lb.color || '#9aa0a6'}"></span>{lb.name}
        </button>
      {/each}
    </div>
  {/if}

  {#if selIds.length > 0}
    <div class="bulkbar">
      <label class="ck-all" title="Select all matching">
        <input class="ck" type="checkbox" checked={allSelected} indeterminate={!allSelected} onchange={toggleSelectAll} aria-label="Select all" />
      </label>
      <span class="bb-count"><b>{selIds.length}</b> selected</span>
      {#if !allSelected && rows.length > selIds.length}
        <button class="bb-selectall" onclick={toggleSelectAll}>Select all {rows.length}</button>
      {/if}
      <span class="bb-spacer"></span>
      <div class="bb-actions">
        <button class="bb-btn" onclick={() => runBulk("closed")}>Close</button>
        <button class="bb-btn" onclick={() => runBulk("archived")}>Archive</button>
        {#if selHasSpam}
          <button class="bb-btn" onclick={() => runBulk("new")}>Not spam</button>
        {/if}
        <button class="bb-btn danger" onclick={() => runBulk("spam")}>Spam</button>
        {#if appState.me?.isAdmin}
          <button class="bb-btn danger solid" onclick={() => runBulk("delete")}>Delete</button>
        {/if}
      </div>
      <button class="bb-x" onclick={clearSel} aria-label="Clear selection" title="Clear selection">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
      </button>
    </div>
  {/if}

  <div class="list" class:compact>
    {#if !rows.length}
      <div class="empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z"/></svg>
        <p>{appState.search || labelFilter || statusFilter || appState.onlyMine ? "No conversations match these filters" : "No conversations yet"}</p>
      </div>
    {/if}

    {#each rows as t (t.id)}
      {@const sla = slaOf(t)}
      {@const selected = selSet.has(t.id)}
      <div class="rowline" class:sel={selected} class:unread={isUnread(t) || isHot(t)}>
        {#if isUnread(t)}<span class="udot" title="New messages"></span>{/if}
        {#if !compact}
          <label class="rowck" title="Select">
            <input class="ck" type="checkbox" checked={selected} onchange={() => toggleSel(t.id)} aria-label={`Select ${t.subject || "conversation"}`} />
          </label>
        {/if}
        <!-- Avatar doubles as the selection toggle (essential on mobile, where
             there is no checkbox column). -->
        <button
          class="avatar"
          class:on={selected && compact}
          style="--ava:{avatarColor(t.customer_email || t.customer_name)}"
          aria-pressed={selected}
          onclick={() => toggleSel(t.id)}
        >
          {#if selected && compact}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
          {:else}
            <span aria-hidden="true">{agentInitials(t.customer_name || t.customer_email)}</span>
          {/if}
          <span class="sr-only">Select conversation from {t.customer_name || t.customer_email || "customer"}</span>
        </button>

        <!-- No aria-label: the row's own text (subject, sender, snippet, status)
             is the accessible name, so speech and screen readers match what is
             on screen. -->
        <button class="row" onclick={() => open(t.id)}>
          {#if compact}
            <span class="m-l1">
              <span class="from">{t.customer_name || t.customer_email || "—"}</span>
              {@render badges(t)}
              <span class="m-spacer"></span>
              <ThreadPresence threadId={t.id} />
              <span class="when">{timeAgo(t.last_message_at)}</span>
            </span>
            <span class="subject">{t.subject || "(no subject)"}</span>
            {#if t.snippet}<span class="snippet-text">{t.snippet}</span>{/if}
            <span class="m-meta">
              {@render statusPill(t)}
              {#if sla}{@render slaChip(sla)}{/if}
              {@render assignee(t)}
              {#if tagsOf(t).length}
                <span class="tagdots" title={tagsOf(t).join(", ")} aria-label={`Labels: ${tagsOf(t).join(", ")}`}>
                  {#each tagsOf(t).slice(0, 3) as tag (tag)}<span class="tdot" style="--tag:{labelColor(tag)}"></span>{/each}
                </span>
              {/if}
            </span>
          {:else}
            <span class="mid">
              <span class="top">
                <span class="subject">{t.subject || "(no subject)"}</span>
                {@render badges(t)}
                {@render tagList(t, 3)}
              </span>
              <span class="snip">
                <span class="from">{t.customer_name || t.customer_email || "—"}</span>
                {#if t.snippet}<span class="snippet-text">{t.snippet}</span>{/if}
              </span>
            </span>
            <span class="asg-col">{@render assignee(t)}</span>
            <span class="right">
              <span class="right-top">
                <ThreadPresence threadId={t.id} />
                <span class="when">{timeAgo(t.last_message_at)}</span>
              </span>
              <span class="right-bot">
                {#if sla}{@render slaChip(sla)}{/if}
                {@render statusPill(t)}
              </span>
            </span>
          {/if}
        </button>

        <span class="qa-anchor" class:open={qaMenu === t.id}>
          <button
            class="qa-dots"
            title="Quick actions"
            aria-label="Quick actions"
            aria-expanded={qaMenu === t.id}
            onclick={(e) => { e.stopPropagation(); openQa(t.id, e.currentTarget); }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
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
                    class:on={tagsOf(t).includes(lb.name)}
                    onclick={(e) => { e.stopPropagation(); qaToggleLabel(t, lb.name); }}
                  >
                    <span class="dot" style="background:{lb.color || '#9aa0a6'}"></span>
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
    /* Rows stop growing past a comfortable reading width; on a wide desktop
       1400px+ rows made the layout feel loose rather than crisp. */
    width: 100%;
    max-width: 1180px;
    margin: 0 auto;
  }

  /* ---------------------------------------------------------------- toolbar */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    padding: 14px 20px 12px;
    min-width: 0;
  }

  .search {
    flex: 0 1 340px;
    min-width: 200px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 6px 0 12px;
    background: var(--m3-surface-raised);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
    color: var(--m3-on-surface-variant-2);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search:focus-within {
    border-color: var(--m3-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--m3-primary) 16%, transparent);
  }
  .search input {
    flex: 1;
    background: none;
    border: 0;
    outline: none;
    min-width: 0;
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
  }
  .search input::placeholder { color: var(--m3-on-surface-variant-2); }
  .search-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: var(--m3-on-surface-variant-2);
  }
  .search-clear:hover { background: var(--m3-row-hover); }

  /* Chips get their own full-width row under the search. Sharing a line
     with the search made them wrap, orphaning the last chip. */
  .filters {
    order: 3;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 100%;
    min-width: 0;
    flex-wrap: wrap;
  }

  /* Filter chip styles (.fchip, .dot, .fcount) are shared — see m3.css. */
  .count {
    margin-left: auto;
    flex: 0 0 auto;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .lblf-wrap { display: inline-flex; flex: 0 0 auto; }
  .lblf-menu {
    position: fixed;
    z-index: 80;
    min-width: 190px;
    max-height: min(360px, 60vh);
    overflow-y: auto;
    background: var(--m3-surface-raised);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-3);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .lblf-menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    text-align: left;
    padding: 7px 10px;
    border-radius: var(--m3-shape-sm);
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
  }
  .lblf-menu button:hover { background: var(--m3-row-hover); }
  .lblf-menu button.sel { background: var(--m3-primary-container); color: var(--m3-on-primary-container); }
  .lblf-menu .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }

  /* --------------------------------------------------------------- checkbox */
  .ck {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    width: 16px;
    height: 16px;
    border: 1.5px solid var(--m3-outline);
    border-radius: 4px;
    background: var(--m3-surface-raised);
    display: inline-grid;
    place-content: center;
    cursor: pointer;
    transition: background 0.1s ease, border-color 0.1s ease;
  }
  .ck::after {
    content: "";
    width: 8px;
    height: 4px;
    border: 2px solid var(--m3-on-primary);
    border-top: 0;
    border-right: 0;
    transform: translateY(-1px) rotate(-45deg);
    opacity: 0;
  }
  .ck:checked, .ck:indeterminate {
    background: var(--m3-primary);
    border-color: var(--m3-primary);
  }
  .ck:checked::after { opacity: 1; }
  .ck:indeterminate::after {
    opacity: 1;
    width: 8px;
    height: 0;
    border-left: 0;
    border-bottom: 2px solid var(--m3-on-primary);
    transform: none;
  }
  .ck:focus-visible { outline: 2px solid var(--m3-primary); outline-offset: 2px; }

  /* ---------------------------------------------------------------- bulkbar */
  .bulkbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 6px 8px 6px 14px;
    margin: 0 20px 10px;
    background: var(--m3-surface-raised);
    color: var(--m3-on-surface);
    border: 1px solid color-mix(in srgb, var(--m3-primary) 35%, var(--m3-outline-variant));
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-2);
  }
  .ck-all { display: inline-flex; align-items: center; }
  .bb-count { font: var(--m3-type-label-lg); color: var(--m3-on-surface-variant); white-space: nowrap; }
  .bb-count b { font-weight: 700; color: var(--m3-on-surface); }
  .bb-selectall {
    font: var(--m3-type-label-md);
    color: var(--m3-primary);
    padding: 4px 6px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .bb-selectall:hover { background: var(--m3-row-hover); }
  .bb-spacer { flex: 1; }
  .bb-actions { display: flex; align-items: center; gap: 6px; }
  .bb-btn {
    height: 32px;
    padding: 0 14px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface);
    border: 1px solid var(--m3-outline-variant);
    background: var(--m3-surface-raised);
    white-space: nowrap;
  }
  .bb-btn:hover { background: var(--m3-row-hover); }
  .bb-btn.danger { color: var(--m3-danger); border-color: color-mix(in srgb, var(--m3-danger) 45%, transparent); }
  .bb-btn.danger.solid { background: var(--m3-danger); color: var(--m3-on-danger); border-color: transparent; }
  .bb-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--m3-on-surface-variant);
    flex: 0 0 auto;
  }
  .bb-x:hover { background: var(--m3-row-hover); }

  /* ------------------------------------------------------------------- list */
  .list {
    flex: 1;
    overflow-y: auto;
    margin: 0 20px 20px;
    padding: 4px 0;
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 70%, transparent);
    border-radius: var(--m3-shape-lg);
    box-shadow: 0 1px 2px rgb(15 40 80 / 0.06);
  }

  .more {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 22px 0 12px;
  }
  .more-hint, .more-end {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
  }
  .more-end { margin: 0; padding: 18px 0 10px; text-align: center; }
  .sentinel { height: 1px; }

  /* Separator as border-top on every row but the first, inset from the card's
     rounded sides, so the last row has no dangling rule. */
  .rowline {
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 8px;
    padding-left: 14px; /* gutter for the unread dot */
    border-radius: var(--m3-shape-sm);
    transition: background 0.1s ease;
  }
  .rowline + .rowline::before {
    content: "";
    position: absolute;
    top: 0;
    left: 14px;
    right: 0;
    border-top: 1px solid color-mix(in srgb, var(--m3-outline-variant) 65%, transparent);
  }
  /* Hide the rule next to a highlighted row so the tint reads as one shape. */
  .rowline.sel::before, .rowline.sel + .rowline::before { opacity: 0; }
  @media (hover: hover) {
    .rowline:hover { background: var(--m3-row-hover); }
    .rowline:hover::before, .rowline:hover + .rowline::before { opacity: 0; }
  }
  .rowline.sel { background: var(--m3-row-active); }

  /* Unread: a dot in its own gutter, so subjects stay left-aligned whether a
     row is read or not (an inline dot shifted the subject by 15px). */
  .udot {
    position: absolute;
    left: 5px;
    top: 50%;
    width: 7px;
    height: 7px;
    margin-top: -3.5px;
    border-radius: 50%;
    background: var(--m3-primary);
  }

  .rowck {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    flex: 0 0 auto;
    align-self: stretch;
    cursor: pointer;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    margin-left: 6px;
    border-radius: 50%;
    background: var(--ava);
    color: #fff;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    flex: 0 0 auto;
    transition: background 0.12s ease, transform 0.12s ease;
  }
  .avatar.on { background: var(--m3-primary); color: var(--m3-on-primary); }
  .avatar:active { transform: scale(0.94); }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    text-align: left;
    padding: 12px 6px 12px 14px;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .row:focus-visible {
    outline: 2px solid var(--m3-primary);
    outline-offset: -2px;
    border-radius: var(--m3-shape-sm);
  }

  .mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .top, .snip {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .snip { gap: 8px; }

  .subject {
    font: var(--m3-type-body-md);
    font-size: 0.9375rem;
    line-height: 1.35;
    color: var(--m3-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1 auto;
    margin-right: 2px;
  }
  .rowline.unread .subject { font-weight: 600; }

  .from {
    font: var(--m3-type-body-sm);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--m3-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 0 auto;
    max-width: 34%;
  }
  .rowline.unread .from { color: var(--m3-on-surface); font-weight: 600; }

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

  /* Badges: tonal, same height, so they read as a quiet group after the
     subject instead of competing with it. */
  .mcount, .ncount, .tag {
    display: inline-flex;
    align-items: center;
    height: 18px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-sm);
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .mcount {
    padding: 0 6px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--m3-on-surface-variant-2);
    background: var(--m3-surface-container);
  }
  .mcount.unread { color: var(--m3-on-primary-container); background: var(--m3-primary-container); }
  /* Internal notes: tertiary (violet), with a speech icon, so it can't be
     confused with the message count beside it. */
  .ncount {
    gap: 3px;
    padding: 0 7px 0 5px;
    font-weight: 700;
    color: var(--m3-on-tertiary-container);
    background: var(--m3-tertiary-container);
  }
  .tag {
    gap: 5px;
    padding: 0 7px 0 6px;
    color: var(--m3-on-surface-variant);
    border: 1px solid var(--m3-outline-variant);
  }
  .tname { overflow: hidden; text-overflow: ellipsis; }
  .tdot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--tag); }
  .tag.more { padding: 0 6px; color: var(--m3-on-surface-variant-2); }
  .pencil { color: var(--m3-tertiary); display: inline-flex; flex: 0 0 auto; }

  /* Assignee gets a fixed column so it lines up down the list. */
  .asg-col {
    flex: 0 0 132px;
    min-width: 0;
    display: flex;
    justify-content: flex-start;
  }
  .assignee {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
  }
  .assignee.mine .ap-name { color: var(--m3-primary); font-weight: 600; }
  .ap-ava {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 8.5px;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .ap-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Right column: time on top, status (and SLA) under it, right-aligned at a
     fixed width so every row's edge lines up. */
  .right {
    flex: 0 0 auto;
    min-width: 108px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 5px;
  }
  .right-top, .right-bot { display: flex; align-items: center; gap: 6px; }
  .when {
    font: var(--m3-type-label-md);
    font-variant-numeric: tabular-nums;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }
  .rowline.unread .when { color: var(--m3-on-surface); font-weight: 600; }

  /* Status and SLA tint from one hue. The text colour is mixed toward
     on-surface so the same hue stays legible on light and dark. */
  .status-pill, .sla-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-sm);
    font-weight: 600;
    white-space: nowrap;
    color: var(--ci);
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .sdot { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
  .sla-chip { gap: 4px; padding: 0 7px 0 6px; font-variant-numeric: tabular-nums; }
  .sla-chip.breached { animation: sla-pulse 1.8s ease-in-out infinite; }
  @keyframes sla-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sla-chip.breached { animation: none; }
  }

  /* --------------------------------------------------- quick actions (⋮) */
  .qa-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0 6px 0 0;
    flex: 0 0 auto;
    align-self: stretch;
  }
  .qa-dots {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--m3-on-surface-variant);
    opacity: 0;
    transition: opacity 0.1s ease, background 0.1s ease;
  }
  .qa-dots:hover { background: var(--m3-surface-container-highest); }
  .rowline:hover .qa-dots,
  .qa-anchor.open .qa-dots,
  .qa-dots:focus-visible { opacity: 1; }
  .qa-anchor.open .qa-dots { background: var(--m3-surface-container-highest); color: var(--m3-primary); }
  @media (hover: none), (pointer: coarse) {
    .qa-dots { opacity: 1; }
    .qa-dots:hover { background: transparent; }
  }

  .qa-pop {
    position: fixed;
    z-index: 90;
    width: 264px;
    max-height: min(400px, 70vh);
    overflow-y: auto;
    background: var(--m3-surface-raised);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-4);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qa-title {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--m3-on-surface-variant-2);
    margin: 6px 4px 2px;
  }
  .qa-optlist { display: flex; flex-direction: column; gap: 1px; }
  .qa-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: var(--m3-shape-sm);
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
    min-height: 34px;
  }
  .qa-opt:hover { background: var(--m3-row-hover); }
  .qa-opt.on { background: var(--m3-primary-container); color: var(--m3-on-primary-container); }
  .qa-ava {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .qa-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qa-check { color: var(--m3-primary); font-weight: 700; flex: 0 0 auto; }
  .qa-wrap { flex-direction: row; flex-wrap: wrap; gap: 5px; padding: 2px; }
  .qa-lbl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
  }
  .qa-lbl .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .qa-lbl.on { background: var(--m3-secondary-container); color: var(--m3-on-secondary-container); border-color: transparent; }
  .qa-none { font-size: 0.8rem; padding: 2px 8px; color: var(--m3-on-surface-variant-2); }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 64px 16px;
    color: var(--m3-on-surface-variant-2);
    font: var(--m3-type-body-md);
    text-align: center;
  }
  .empty svg { opacity: 0.45; }

  /* Mid-width desktop: assignee collapses to its avatar. */
  @media (max-width: 1000px) {
    .asg-col { flex-basis: 22px; }
    .asg-col .ap-name { display: none; }
  }

  /* ------------------------------------------------------------------ mobile */
  @media (max-width: 620px) {
    /* nowrap matters: a wrapping column sizes its line to the widest child's
       content, so the 820px chip strip stretched the search off-screen. */
    .toolbar {
      flex-direction: column;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 10px;
      padding: 10px 0 8px;
    }
    .search { flex: none; margin: 0 12px; height: 42px; min-width: 0; }
    /* One scrolling row of chips; wrapping left "Closed 1" orphaned on a
       second line. Edge-to-edge so chips visibly continue off-screen. */
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding: 0 12px;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .filters::-webkit-scrollbar { display: none; }
    .fchip { height: 32px; }
    .count { display: none; }
    .filters { order: 0; flex: none; }

    .bulkbar {
      position: sticky;
      top: 0;
      z-index: 5;
      margin: 0 8px 8px;
      flex-wrap: wrap;
      row-gap: 4px;
    }
    .bb-spacer { display: none; }
    .bb-selectall { margin-right: auto; }
    .bb-actions {
      order: 5;
      flex: 1 1 100%;
      overflow-x: auto;
      scrollbar-width: none;
      padding-bottom: 2px;
    }

    /* Full-bleed list, like a native mail app: the card-inside-a-page inset
       cost 28px of width that the rows badly need on a phone. */
    .list {
      margin: 0;
      padding: 0 0 12px;
      border: 0;
      border-top: 1px solid color-mix(in srgb, var(--m3-outline-variant) 60%, transparent);
      border-radius: 0;
      box-shadow: none;
    }

    .rowline {
      margin: 0;
      padding-left: 14px;
      border-radius: 0;
      align-items: flex-start;
    }
    /* Separator starts at the text column, not the avatar. */
    .rowline + .rowline::before { left: 66px; }
    .udot { top: 30px; margin-top: 0; left: 4px; }

    .avatar {
      width: 40px;
      height: 40px;
      margin: 12px 0 0;
      font-size: 14px;
    }

    .row {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      padding: 11px 14px 12px 12px;
    }

    .m-l1 {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .m-l1 .from {
      flex: 0 1 auto;
      max-width: none;
      font: var(--m3-type-body-md);
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--m3-on-surface);
    }
    .rowline.unread .m-l1 .from { font-weight: 700; }
    .m-spacer { flex: 1 1 auto; }
    .when { font-size: 0.75rem; }

    .subject { font-size: 0.875rem; margin: 0; color: var(--m3-on-surface-variant); }
    .rowline.unread .subject { color: var(--m3-on-surface); }
    .snippet-text { font-size: 0.8125rem; flex: none; }

    /* Chip line; right padding keeps clear of the ⋮ button. */
    /* Always one line: status, SLA, assignee avatar, then labels as a dot
       cluster. Full tag chips wrapped the row or truncated to "s…". */
    .m-meta {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 5px;
      /* overflow:hidden is a backstop so an unusually long chip line clips
         rather than sliding under the ⋮; the 3px padding keeps the "You"
         ring around the assignee avatar from being clipped. */
      overflow: hidden;
      margin: 4px 0 0 -3px;
      padding: 3px;
      min-height: 20px;
    }
    .m-meta .ap-name { display: none; }
    .m-meta > * { flex: 0 0 auto; }
    .m-meta .status-pill, .m-meta .sla-chip { padding: 0 7px 0 6px; gap: 4px; }
    .tagdots {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      height: 20px;
      padding: 0 2px;
    }
    .tagdots .tdot { width: 8px; height: 8px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.08); }
    .m-meta .assignee.mine .ap-ava { box-shadow: 0 0 0 2px var(--m3-surface-raised), 0 0 0 3.5px var(--m3-primary); }

    /* ⋮ sits beside the subject line: the subject already ellipsises, so it
       can give up the room; the chip line can't, and on a 360px phone the
       ⋮ there overlapped the chips. */
    .qa-anchor {
      position: absolute;
      right: 6px;
      top: 27px;
      padding: 0;
      align-self: auto;
    }
    .subject { padding-right: 30px; }
    .qa-dots { width: 34px; height: 34px; color: var(--m3-on-surface-variant-2); }
  }
</style>
