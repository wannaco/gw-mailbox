<script>
  import { appState, STATUSES, toast } from "../lib/appState.svelte.js";
  import { moveThread, refreshThreads, bulkThreads } from "../lib/api.js";
  import Card from "./Card.svelte";

  let { open } = $props();

  let dragId = $state("");
  let hoverCol = $state("");
  let selectMode = $state(false);
  let selIds = $state([]);

  // ---- column visibility (per-user, persisted) ------------------------------
  const COLS_KEY = () => "gwmb.boardCols." + (appState.me?.id || "anon");
  let colMenuOpen = $state(false);
  let hiddenCols = $state([]);
  try {
    hiddenCols = JSON.parse(localStorage.getItem(COLS_KEY()) || "[]");
    if (!Array.isArray(hiddenCols)) hiddenCols = [];
  } catch { hiddenCols = []; }
  function isColHidden(v) { return hiddenCols.includes(v); }
  function toggleCol(v) {
    hiddenCols = isColHidden(v) ? hiddenCols.filter((x) => x !== v) : [...hiddenCols, v];
    try { localStorage.setItem(COLS_KEY(), JSON.stringify(hiddenCols)); } catch {}
  }
  const boardCols = $derived(STATUSES.filter((c) => !hiddenCols.includes(c.value)));

  const visible = $derived(
    Object.values(appState.threads)
      .filter((t) => t.inbox === appState.activeInboxId)
      .filter((t) => {
        // “My tickets”: only threads assigned to ME — unassigned excluded too.
        if (appState.onlyMine && t.assigned_agent !== appState.me?.id) return false;
        if (!appState.search) return true;
        const q = appState.search.toLowerCase();
        return (
          (t.subject || "").toLowerCase().includes(q) ||
          (t.customer_email || "").toLowerCase().includes(q) ||
          (t.customer_name || "").toLowerCase().includes(q) ||
          (t.snippet || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))
  );

  const selSet = $derived(new Set(selIds));
  const allSelected = $derived(selectMode && visible.length > 0 && visible.every((t) => selSet.has(t.id)));

  function byStatus(status) {
    return visible.filter((t) => (t.status || "new") === status);
  }

  // Card -> Board drag lifecycle. Board must know WHICH card is in flight:
  // dataTransfer contents are unreadable during dragover, so the column could
  // never call preventDefault() and the browser refused every drop.
  function startCardDrag(id) {
    dragId = id;
  }
  function endCardDrag() {
    dragId = "";
    hoverCol = "";
  }

  // `fallbackId` comes from dataTransfer on drop (belt & braces if the drag
  // started outside our handlers, e.g. a re-render mid-drag).
  async function dropOn(status, fallbackId) {
    const id = dragId || fallbackId || "";
    dragId = "";
    hoverCol = "";
    if (!id) return;
    const thread = appState.threads[id];
    if (!thread || thread.status === status) return;
    const prev = thread.status;
    thread.status = status; // optimistic
    try {
      await moveThread(id, status);
    } catch (e) {
      thread.status = prev;
      toast("error", "Move failed: " + (e?.message || ""));
    }
  }

  async function refresh() {
    try {
      await refreshThreads();
      toast("success", "Board refreshed");
    } catch (e) {
      toast("error", e?.message || "Refresh failed");
    }
  }

  // ---- bulk selection -------------------------------------------------------
  function enterSelect() {
    selectMode = true;
  }
  function exitSelect() {
    selectMode = false;
    selIds = [];
  }
  function toggleSel(id) {
    selIds = selSet.has(id) ? selIds.filter((x) => x !== id) : [...selIds, id];
  }
  function selectAllVisible() {
    selIds = visible.map((t) => t.id);
  }

  const ACTION_LABEL = { spam: "spam", archived: "archive", closed: "closed", delete: "deleted", new: "moved back to New" };

  // "Not spam" appears only when the selection contains spam — see ListView for
  // why the bulk spam action needed a way back.
  const selHasSpam = $derived(selIds.some((id) => appState.threads[id]?.status === "spam"));
  async function runBulk(action) {
    if (!selIds.length) return;
    const n = selIds.length;
    if (action === "delete" && !confirm(`Delete ${n} conversation${n === 1 ? "" : "s"} permanently? Messages and notes inside them will be removed too.`)) return;
    try {
      const res = await bulkThreads(selIds, action);
      const ok = res?.processed || 0;
      // Optimistic local update so THIS session reflects the change instantly.
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
      await refreshThreads();
      selIds = [];
      toast("success", ok ? `Done — ${ok} conversation${ok === 1 ? "" : "s"} ${ACTION_LABEL[action]}` : "No changes applied");
    } catch (e) {
      toast("error", e?.message || "Bulk action failed");
    }
  }
</script>

<div class="board-wrap">
  <div class="toolbar">
    <div class="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 3a6.5 6.5 0 1 0 4.05 11.55l4.95 4.95 1.5-1.5-4.95-4.95A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>
      <input bind:value={appState.search} placeholder="Search threads…" />
    </div>
    <button class="md3-chip" class:is-active={appState.onlyMine} onclick={() => (appState.onlyMine = !appState.onlyMine)}>
      My tickets
    </button>
    <button class="md3-chip" class:is-active={colMenuOpen} onclick={() => (colMenuOpen = !colMenuOpen)} title="Show / hide board columns">
      Columns{hiddenCols.length ? " · " + hiddenCols.length + " hidden" : ""}
    </button>
    {#if colMenuOpen}
      <div class="col-backdrop" onclick={() => (colMenuOpen = false)}></div>
      <div class="col-menu" role="menu" aria-label="Toggle board columns">
        {#each STATUSES as c (c.value)}
          <label class="col-opt">
            <input type="checkbox" checked={!isColHidden(c.value)} onchange={() => toggleCol(c.value)} />
            <span class="dot" style="background:{c.dot}"></span>
            <span class="col-opt-name">{c.label}</span>
            <span class="col-opt-count">{byStatus(c.value).length}</span>
          </label>
        {/each}
      </div>
    {/if}
    <button class="md3-chip" onclick={refresh} title="Re-fetch from server">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2L7 7l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      Sync
    </button>
  </div>

  {#if selectMode}
    <div class="bulkbar">
      <span class="bb-count"><b>{selIds.length}</b> selected</span>
      {#if !allSelected}
        <button class="bb-selectall" onclick={selectAllVisible}>Select all {visible.length} matching</button>
      {/if}
      <span class="bb-spacer"></span>
      <button class="md3-btn small" onclick={() => runBulk("closed")} disabled={!selIds.length}>Close</button>
      <button class="md3-btn small" onclick={() => runBulk("archived")} disabled={!selIds.length}>Archive</button>
      {#if selHasSpam}
        <button class="md3-btn small" onclick={() => runBulk("new")} disabled={!selIds.length}>Not spam</button>
      {/if}
      <button class="md3-btn small danger" onclick={() => runBulk("spam")} disabled={!selIds.length}>Mark spam</button>
      {#if appState.me?.isAdmin}
        <button class="md3-btn small danger solid" onclick={() => runBulk("delete")} disabled={!selIds.length}>Delete</button>
      {/if}
      <button class="md3-btn small tonal" onclick={() => (selIds = [])}>Clear</button>
    </div>
  {/if}

  <div class="board">
    {#each boardCols as col (col.value)}
      <section
        class="column"
        class:drag-over={hoverCol === col.value}
        ondragover={(e) => {
          if (selectMode || !dragId) return;
          e.preventDefault();               // required: lets the browser allow the drop
          e.dataTransfer.dropEffect = "move";
          hoverCol = col.value;
        }}
        ondragleave={() => (hoverCol = "")}
        ondrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
          dropOn(col.value, id);
        }}
      >
        <header class="col-head">
          <span class="dot" style="background:{col.dot}"></span>
          <span class="col-title">{col.label}</span>
          <span class="count">{byStatus(col.value).length}</span>
        </header>
        <div class="cards">
          {#each byStatus(col.value) as thread (thread.id)}
            <Card
              thread={thread}
              open={open}
              selectable={selectMode}
              selected={selSet.has(thread.id)}
              onToggleSelect={toggleSel}
              onDragStart={startCardDrag}
              onDragEnd={endCardDrag}
            />
          {/each}
          {#if !byStatus(col.value).length}
            <div class="col-empty">—</div>
          {/if}
        </div>
      </section>
    {/each}
  </div>
</div>

<style>
  .board-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .toolbar {
    position: relative;
    /* Only needs to sit above the board's columns (which follow it in the
       flow). Kept well under the topbar's z-index 30 so account/roster
       dropdowns render above this toolbar. */
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    flex-wrap: wrap;
  }

  .search {
    flex: 1;
    min-width: 220px;
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
  .bulkbar .md3-btn.danger.solid { background: var(--m3-danger); color: var(--m3-on-danger); }
  .bulkbar .md3-btn.danger:not(.solid) { border: 1px solid var(--m3-danger); color: var(--m3-danger); }

  .board {
    flex: 1;
    display: flex;
    gap: 14px;
    padding: 6px 20px 20px;
    overflow-x: auto;
    min-height: 0;
    align-items: flex-start;
  }

  .column {
    flex: 1 1 280px;
    min-width: 250px;
    max-width: 340px;
    display: flex;
    flex-direction: column;
    background: var(--m3-surface-container-lowest);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    transition: background 0.15s ease, border-color 0.15s ease;
    max-height: 100%;
  }
  .column.drag-over {
    background: var(--m3-surface-container-low);
    outline: 2px dashed var(--m3-primary);
    outline-offset: -2px;
  }

  .column.drag-over {
    background: var(--m3-secondary-container);
    outline: 2px dashed var(--m3-secondary);
  }

  .col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 12px 8px;
    position: sticky;
    top: 0;
  }

  .col-head .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }

  .col-title {
    font: var(--m3-type-title-sm);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    background: var(--m3-surface-container);
    color: var(--m3-on-surface-variant);
    border-radius: 6px;
    min-width: 22px;
    text-align: center;
    padding: 2px 7px;
    font: var(--m3-type-label-md);
    font-weight: 600;
  }

  .cards {
    padding: 2px 10px 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }

  .col-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
  }
  .col-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 41;
    min-width: 220px;
    background: var(--m3-surface-container, #fff);
    border: 1px solid var(--m3-outline-variant, #e0e0e0);
    border-radius: 12px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .col-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 8px;
    cursor: pointer;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface);
  }
  .col-opt:hover { background: var(--m3-surface-container-high); }
  .col-opt input { accent-color: var(--m3-primary); }
  .col-opt .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .col-opt-name { flex: 1; }
  .col-opt-count {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }
  .col-empty {
    text-align: center;
    color: var(--m3-outline);
    font-size: 1.2rem;
    padding: 26px 0;
  }

  @media (max-width: 720px) {
    .column {
      flex: 0 0 85vw;
    }
  }
</style>
