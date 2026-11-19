<script>
  import { appState, STATUSES, toast } from "../lib/appState.svelte.js";
  import { moveThread, refreshThreads, bulkThreads, listLabels } from "../lib/api.js";
  import Card from "./Card.svelte";
  import { tick } from "svelte";

  let { open } = $props();

  // Label colours for card tags (same catalog the list uses).
  $effect(() => {
    if (appState.labels.length) return;
    listLabels()
      .then((r) => (appState.labels = (r.items || []).map((l) => ({ name: l.name, color: l.color || "" }))))
      .catch(() => {});
  });

  // Phones show one lane at a time; start on the first lane that has
  // conversations rather than an empty "New" lane. Once only, so it never
  // fights the user's own scrolling.
  let boardEl = $state(null);
  let didInitialScroll = false;
  $effect(() => {
    if (didInitialScroll || !boardEl || !visible.length) return;
    didInitialScroll = true;
    if (!window.matchMedia("(max-width: 720px)").matches) return;
    const firstFull = boardCols.findIndex((c) => byStatus(c.value).length > 0);
    const col = boardEl.children[firstFull];
    if (firstFull > 0 && col) boardEl.scrollLeft = col.offsetLeft - boardEl.offsetLeft - 12;
  });

  // ---- keyboard navigation -------------------------------------------------
  //   ←/→        nearest card in the neighbouring lane (empty lanes skipped)
  //   ↑/↓        previous / next card in the lane;  Home/End: first / last
  //   Shift+←/→  move the card itself to the adjacent lane — the keyboard
  //              equivalent of drag-and-drop, which was mouse-only.
  let announce = $state("");
  const cardsIn = (colEl) => [...colEl.querySelectorAll(".card")];
  function focusCard(el) {
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  async function onBoardKey(e) {
    const card = e.target?.closest?.(".card");
    if (!card || !boardEl || e.altKey || e.ctrlKey || e.metaKey) return;
    const cols = [...boardEl.querySelectorAll(".column")];
    const colEl = card.closest(".column");
    const ci = cols.indexOf(colEl);
    const mine = cardsIn(colEl);
    const ri = mine.indexOf(card);
    const horiz = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;

    if (horiz && e.shiftKey) {
      e.preventDefault();
      if (selectMode) return;
      const ti = ci + horiz;
      if (ti < 0 || ti >= boardCols.length) return;
      const id = card.dataset.id;
      const to = boardCols[ti];
      await dropOn(to.value, id);
      await tick();
      focusCard(boardEl.querySelector(`.card[data-id="${id}"]`));
      announce = `Moved to ${to.label}`;
      return;
    }
    if (horiz) {
      e.preventDefault();
      for (let i = ci + horiz; i >= 0 && i < cols.length; i += horiz) {
        const list = cardsIn(cols[i]);
        if (list.length) { focusCard(list[Math.min(ri, list.length - 1)]); return; }
      }
      return;
    }
    let target = null;
    if (e.key === "ArrowDown") target = mine[ri + 1];
    else if (e.key === "ArrowUp") target = mine[ri - 1];
    else if (e.key === "Home") target = mine[0];
    else if (e.key === "End") target = mine[mine.length - 1];
    else return;
    e.preventDefault();
    focusCard(target);
  }

  // Arrow keys work on the board even when no card has focus yet (after a
  // click on empty space, or on the List/Board toggle): the first press
  // lands on the first card. Ignored while typing, inside menus/tablists,
  // and while a conversation is open over the board.
  const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  $effect(() => {
    const h = (e) => {
      if (!ARROWS.includes(e.key) || e.defaultPrevented || !boardEl) return;
      if (e.altKey || e.ctrlKey || e.metaKey || appState.openThreadId) return;
      const a = document.activeElement;
      if (a?.closest?.(".card")) return; // the board's own handler has it
      if (a && a !== document.body) {
        if (a.matches("input, textarea, select, [contenteditable], [contenteditable] *")) return;
        if (a.closest('[role="tablist"], [role="menu"], [role="listbox"], [role="dialog"], .col-menu')) return;
      }
      const first = boardEl.querySelector(".card");
      if (!first) return;
      e.preventDefault();
      focusCard(first);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

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

  // Columns popover closes on Escape and returns focus to its chip.
  let colChip = $state(null);
  let colMenuEl = $state(null);
  // Move focus into the popover when it opens (autofocus doesn't fire for
  // elements Svelte inserts after page load).
  $effect(() => {
    if (colMenuOpen && colMenuEl) colMenuEl.querySelector("input")?.focus();
  });
  function closeColMenu() {
    colMenuOpen = false;
    colChip?.focus();
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
    <div class="search-pill">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.5 3a6.5 6.5 0 1 0 4.05 11.55l4.95 4.95 1.5-1.5-4.95-4.95A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>
      <input bind:value={appState.search} placeholder="Search conversations" aria-label="Search conversations" />
    </div>

    <div class="filters">
      <button class="fchip" class:is-active={appState.onlyMine} aria-pressed={appState.onlyMine} onclick={() => (appState.onlyMine = !appState.onlyMine)}>
        My tickets
      </button>
      <span class="col-anchor">
        <button
          class="fchip"
          class:is-active={colMenuOpen || hiddenCols.length > 0}
          aria-expanded={colMenuOpen}
          aria-controls="board-col-menu"
          bind:this={colChip}
          onclick={() => (colMenuOpen = !colMenuOpen)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5v14h5V5H3zm7 0v14h4V5h-4zm6 0v14h5V5h-5z"/></svg>
          Columns{hiddenCols.length ? ` · ${hiddenCols.length} hidden` : ""}
        </button>
        {#if colMenuOpen}
          <div class="col-backdrop" aria-hidden="true" onclick={() => (colMenuOpen = false)}></div>
          <!-- A group of checkboxes, not role="menu": menus may only contain
               menuitems, and these are genuine on/off toggles. -->
          <div
            bind:this={colMenuEl}
            class="col-menu"
            id="board-col-menu"
            role="group"
            aria-label="Visible columns"
            onkeydown={(e) => { if (e.key === "Escape") { e.preventDefault(); closeColMenu(); } }}
          >
            <p class="col-menu-title">Show columns</p>
            {#each STATUSES as c (c.value)}
              <label class="col-opt">
                <input class="ck" type="checkbox" checked={!isColHidden(c.value)} onchange={() => toggleCol(c.value)} />
                <span class="dot" style="background:{c.dot}"></span>
                <span class="col-opt-name">{c.label}</span>
                <span class="col-opt-count">{byStatus(c.value).length}</span>
              </label>
            {/each}
          </div>
        {/if}
      </span>
      <button class="fchip" class:is-active={selectMode} aria-pressed={selectMode} onclick={() => (selectMode ? exitSelect() : enterSelect())}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9z"/></svg>
        {selectMode ? "Done" : "Select"}
      </button>
    </div>

    <!-- Visible hint for the keyboard shortcuts (pointer devices only). -->
    <span class="kbd-hint" aria-hidden="true">
      <kbd>←</kbd><kbd>→</kbd> lanes · <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> move card
    </span>
    <button class="icon-btn" onclick={refresh} title="Refresh board" aria-label="Refresh board">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
    </button>
  </div>

  {#if selectMode}
    <div class="bulkbar" role="region" aria-label="Bulk actions">
      <span class="bb-count" aria-live="polite"><b>{selIds.length}</b> selected</span>
      {#if !allSelected && visible.length}
        <button class="bb-link" onclick={selectAllVisible}>Select all {visible.length}</button>
      {/if}
      {#if selIds.length}
        <button class="bb-link" onclick={() => (selIds = [])}>Clear</button>
      {/if}
      <span class="bb-spacer"></span>
      <div class="bb-actions">
        <button class="bb-btn" onclick={() => runBulk("closed")} disabled={!selIds.length}>Close</button>
        <button class="bb-btn" onclick={() => runBulk("archived")} disabled={!selIds.length}>Archive</button>
        {#if selHasSpam}
          <button class="bb-btn" onclick={() => runBulk("new")} disabled={!selIds.length}>Not spam</button>
        {/if}
        <button class="bb-btn danger" onclick={() => runBulk("spam")} disabled={!selIds.length}>Spam</button>
        {#if appState.me?.isAdmin}
          <button class="bb-btn danger solid" onclick={() => runBulk("delete")} disabled={!selIds.length}>Delete</button>
        {/if}
      </div>
    </div>
  {/if}

  <p id="board-kbd-help" class="sr-only">Arrow keys move between cards. Shift plus left or right arrow moves the card to the next column.</p>
  <p class="sr-only" aria-live="polite">{announce}</p>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="board" bind:this={boardEl} onkeydown={onBoardKey}>
    {#each boardCols as col (col.value)}
      {@const items = byStatus(col.value)}
      <section
        class="column"
        class:drag-over={hoverCol === col.value}
        aria-labelledby="col-{col.value}"
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
        <header class="col-head" style="--c:{col.dot}">
          <span class="dot" aria-hidden="true"></span>
          <h2 class="col-title" id="col-{col.value}">{col.label}</h2>
          <span class="count" aria-label={`${items.length} conversation${items.length === 1 ? "" : "s"}`}>{items.length}</span>
        </header>
        <div class="cards">
          {#each items as thread (thread.id)}
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
          {#if !items.length}
            <!-- Compact, and doubles as a visible drop target while dragging. -->
            <p class="col-empty">{dragId ? "Drop here" : "No conversations"}</p>
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

  /* ---------------------------------------------------------------- toolbar */
  .toolbar {
    position: relative;
    /* Above the columns, below the topbar (z 30) so account menus overlay. */
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px 12px;
    min-width: 0;
  }
  .search-pill {
    flex: 0 1 340px;
    min-width: 200px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    background: var(--m3-surface-raised);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
    color: var(--m3-on-surface-variant-2);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .search-pill:focus-within {
    border-color: var(--m3-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--m3-primary) 16%, transparent);
  }
  .search-pill input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--m3-on-surface-variant);
    flex: 0 0 auto;
  }
  .icon-btn:hover { background: var(--m3-row-hover); }
  .kbd-hint {
    display: none;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }
  .kbd-hint kbd {
    display: inline-grid;
    place-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border: 1px solid var(--m3-outline-variant);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--m3-surface-raised);
    font: inherit;
    font-weight: 600;
    color: var(--m3-on-surface-variant);
  }
  @media (hover: hover) and (pointer: fine) and (min-width: 1100px) {
    .kbd-hint { display: inline-flex; }
  }

  .col-anchor { position: relative; display: inline-flex; }
  .col-backdrop { position: fixed; inset: 0; z-index: 40; }
  .col-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 41;
    min-width: 230px;
    background: var(--m3-surface-raised);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-3);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .col-menu-title {
    margin: 4px 8px 6px;
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--m3-on-surface-variant-2);
  }
  .col-opt {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: var(--m3-shape-sm);
    cursor: pointer;
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
  }
  .col-opt:hover { background: var(--m3-row-hover); }
  .col-opt .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .col-opt-name { flex: 1; }
  .col-opt-count { font: var(--m3-type-label-md); color: var(--m3-on-surface-variant-2); font-variant-numeric: tabular-nums; }

  /* Same custom checkbox as the list. */
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
    flex: none;
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
  .ck:checked { background: var(--m3-primary); border-color: var(--m3-primary); }
  .ck:checked::after { opacity: 1; }

  /* ---------------------------------------------------------------- bulkbar */
  .bulkbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 6px 8px 6px 14px;
    margin: 0 20px 10px;
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-primary) 35%, var(--m3-outline-variant));
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-2);
    flex-wrap: wrap;
  }
  .bb-count { font: var(--m3-type-label-lg); color: var(--m3-on-surface-variant); white-space: nowrap; }
  .bb-count b { font-weight: 700; color: var(--m3-on-surface); }
  .bb-link { font: var(--m3-type-label-md); color: var(--m3-primary); padding: 4px 6px; border-radius: 6px; white-space: nowrap; }
  .bb-link:hover { background: var(--m3-row-hover); }
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
  .bb-btn:hover:not(:disabled) { background: var(--m3-row-hover); }
  .bb-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .bb-btn.danger { color: var(--m3-danger); border-color: color-mix(in srgb, var(--m3-danger) 45%, transparent); }
  .bb-btn.danger.solid { background: var(--m3-danger); color: var(--m3-on-danger); border-color: transparent; }

  /* ------------------------------------------------------------------ board */
  .board {
    flex: 1;
    display: flex;
    gap: 12px;
    padding: 2px 20px 20px;
    overflow-x: auto;
    min-height: 0;
    align-items: flex-start;
  }

  /* Lanes are a tinted surface and the cards are white, so cards lift off
     the lane. White-on-white with borders everywhere read as a grid of
     boxes rather than a board. */
  .column {
    flex: 1 1 272px;
    min-width: 256px;
    max-width: 340px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--m3-surface-container);
    border-radius: var(--m3-shape-lg);
    transition: background 0.15s ease, box-shadow 0.15s ease;
  }
  .column.drag-over {
    background: color-mix(in srgb, var(--m3-primary) 10%, var(--m3-surface-container));
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--m3-primary) 55%, transparent);
  }

  .col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 10px;
  }
  .col-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
  .col-title {
    margin: 0;
    flex: 1;
    min-width: 0;
    font: var(--m3-type-title-sm);
    color: var(--m3-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    min-width: 22px;
    height: 20px;
    padding: 0 7px;
    display: inline-grid;
    place-content: center;
    border-radius: var(--m3-shape-full);
    background: var(--m3-surface-raised);
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-sm);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .cards {
    padding: 0 8px 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
  }
  .col-empty {
    margin: 0;
    padding: 14px 10px;
    border: 1.5px dashed color-mix(in srgb, var(--m3-outline-variant) 90%, transparent);
    border-radius: var(--m3-shape-md);
    text-align: center;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
  }
  .column.drag-over .col-empty { border-color: var(--m3-primary); color: var(--m3-primary); }

  /* ----------------------------------------------------------------- mobile */
  @media (max-width: 720px) {
    .toolbar { flex-wrap: wrap; padding: 10px 12px 8px; gap: 10px; }
    .search-pill { flex: 1 1 100%; height: 42px; }
    .filters { overflow-x: auto; scrollbar-width: none; }
    .filters::-webkit-scrollbar { display: none; }
    .bulkbar { margin: 0 12px 8px; }
    .bb-spacer { display: none; }
    .bb-actions { flex: 1 1 100%; overflow-x: auto; }
    /* One lane at a time, snapping, with the next lane peeking in so it's
       obvious the board scrolls sideways. */
    .board {
      padding: 2px 12px 12px;
      scroll-snap-type: x mandatory;
      scroll-padding: 0 12px;
      gap: 10px;
    }
    .column {
      flex: 0 0 84vw;
      max-width: none;
      scroll-snap-align: start;
    }
  }
</style>
