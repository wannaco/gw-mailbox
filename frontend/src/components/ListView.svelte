<script>
  import { appState, statusMeta, threadUnread, slaOf, toast, STATUSES } from "../lib/appState.svelte.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";
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
  const ACTION_LABEL = { spam: "spam", archived: "archive", closed: "closed", delete: "deleted" };
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
    <span class="count">{rows.length} conversation{rows.length === 1 ? "" : "s"}</span>
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
      <button class="md3-btn small danger" onclick={() => runBulk("spam")} disabled={selIds.length === 0}>Mark spam</button>
      {#if appState.me?.isSuperuser}
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
            </span>
            {#if assignedName(t)}
              <span class="assignee-pill" class:mine={t.assigned_agent === appState.me?.id} title={`Assigned to ${assignedName(t)}`}>
                <span class="ap-ava" style="background:{avatarColor(t.assigned_agent)}">{agentInitials(assignedName(t))}</span>
                <span class="ap-name">{assignedName(t)}</span>
              </span>
            {/if}
          </span>

          <span class="right">
            <span class="when">{timeAgo(t.last_message_at)}</span>
            <span class="status-pill" style="background:{statusMeta(t.status).dot}22;color:{statusMeta(t.status).dot}">
              {statusMeta(t.status).label}
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
  </div>
</div>

<style>
  .list-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px 8px;
    flex-wrap: wrap;
  }

  .search {
    flex: 1;
    min-width: 200px;
    max-width: 420px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 14px;
    background: var(--m3-surface-container-high);
    border-radius: var(--m3-shape-full);
    color: var(--m3-on-surface-variant);
  }
  .search input {
    flex: 1;
    background: none;
    border: 0;
    outline: none;
    min-width: 0;
  }

  .count {
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface-variant-2);
    margin-right: 4px;
  }

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
    padding: 6px 18px;
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
    border-radius: var(--m3-shape-sm);
    margin: 0 16px 8px;
    flex-wrap: wrap;
  }
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

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 16px 16px;
  }

  .rowline {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--m3-outline-variant);
  }
  .rowline:hover {
    background: var(--m3-row-hover);
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
    gap: 14px;
    text-align: left;
    padding: 10px 14px 10px 4px;
    border: 0;
    background: none;
    cursor: pointer;
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
  .qa-anchor.open .qa-dots { opacity: 1; }
  .qa-anchor.open .qa-dots { background: var(--m3-surface-container-highest); color: var(--m3-primary); }

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
    gap: 2px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .subject {
    font: var(--m3-type-body-lg);
    font-weight: 400;
    color: var(--m3-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.hot .subject,
  .row.unread .subject {
    font-weight: 600;
    color: var(--m3-on-surface);
  }

  .unread-dot {
    width: 8px;
    height: 8px;
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

  .snip {
    display: flex;
    gap: 8px;
    min-width: 0;
    align-items: baseline;
  }

  .from {
    font: var(--m3-type-body-md);
    font-weight: 600;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .snippet-text {
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.hot .from {
    color: var(--m3-on-surface);
  }

  .assignee-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    border-radius: 999px;
    padding: 1px 9px 1px 3px;
    font: var(--m3-type-label-sm);
    font-weight: 500;
    max-width: 100%;
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

  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 5px;
    flex: 0 0 auto;
  }

  .when {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }

  .status-pill {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 4px;
    padding: 1px 7px;
    white-space: nowrap;
  }

  .sla-chip {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
    border: 1px solid currentColor;
  }
  .sla-chip.breached {
    animation: sla-pulse 1.8s ease-in-out infinite;
  }
  @keyframes sla-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .empty {
    text-align: center;
    color: var(--m3-on-surface-variant-2);
    padding: 48px 0;
    font: var(--m3-type-body-md);
  }
</style>
