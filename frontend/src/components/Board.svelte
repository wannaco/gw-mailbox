<script>
  import { appState, STATUSES, toast } from "../lib/appState.svelte.js";
  import { moveThread, refreshThreads } from "../lib/api.js";
  import Card from "./Card.svelte";

  let { open } = $props();

  let dragId = $state("");
  let hoverCol = $state("");

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

  function byStatus(status) {
    return visible.filter((t) => (t.status || "new") === status);
  }

  async function dropOn(status) {
    if (!dragId) return;
    const thread = appState.threads[dragId];
    dragId = "";
    hoverCol = "";
    if (!thread || thread.status === status) return;
    const prev = thread.status;
    thread.status = status; // optimistic
    try {
      await moveThread(dragId, status);
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
    <button class="md3-chip" onclick={refresh} title="Re-fetch from server">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2L7 7l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
      Sync
    </button>
  </div>

  <div class="board">
    {#each STATUSES as col (col.value)}
      <section
        class="column"
        class:drag-over={hoverCol === col.value}
        ondragover={(e) => {
          if (dragId && dragId !== "") {
            e.preventDefault();
            hoverCol = col.value;
          }
        }}
        ondragleave={() => (hoverCol = "")}
        ondrop={(e) => {
          e.preventDefault();
          dropOn(col.value);
        }}
      >
        <header class="col-head">
          <span class="dot" style="background:{col.dot}"></span>
          <span class="col-title">{col.label}</span>
          <span class="count">{byStatus(col.value).length}</span>
        </header>
        <div class="cards">
          {#each byStatus(col.value) as thread (thread.id)}
            <Card thread={thread} open={open} />
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

  .board {
    flex: 1;
    display: flex;
    gap: 12px;
    padding: 4px 16px 16px;
    overflow-x: auto;
    min-height: 0;
  }

  .column {
    flex: 1 1 280px;
    min-width: 250px;
    max-width: 340px;
    display: flex;
    flex-direction: column;
    background: var(--m3-surface-container-low);
    border-radius: var(--m3-shape-md);
    transition: background 0.15s ease;
  }

  .column.drag-over {
    background: var(--m3-secondary-container);
    outline: 2px dashed var(--m3-secondary);
  }

  .col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 6px;
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
    background: var(--m3-surface-container-highest);
    color: var(--m3-on-surface-variant);
    border-radius: var(--m3-shape-full);
    min-width: 22px;
    text-align: center;
    padding: 1px 7px;
    font: var(--m3-type-label-md);
  }

  .cards {
    padding: 2px 8px 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
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
