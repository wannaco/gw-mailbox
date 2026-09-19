<script>
  import { appState, unreadNotifs } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";
  import { timeAgo } from "../lib/utils.js";

  let open = $state(false);
  const unread = $derived(unreadNotifs());
  const items = $derived(appState.notifications || []);

  function kindLabel(k) {
    return k === "mention" ? "mentioned you" : k === "assigned" ? "assigned" : "new note";
  }

  async function onOpen() {
    open = !open;
    if (open) await api.loadNotifications();
  }

  async function openNotif(n) {
    if (n.thread) {
      appState.openThreadId = n.thread;
      if (n.message_id) appState.jumpToMessage = n.message_id;
    }
    open = false;
    if (!n.read) {
      try {
        await api.markNotifRead(n.id);
        n.read = true;
      } catch { /* ok */ }
    }
  }

  async function markAll() {
    try {
      await api.markAllNotifsRead();
      for (const n of items) n.read = true;
    } catch { /* ok */ }
  }
</script>

<div class="notif">
  <button class="bell" title="Notifications" onclick={onOpen} aria-expanded={open}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.93 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
    {#if unread > 0}<span class="badge">{unread > 99 ? "99+" : unread}</span>{/if}
  </button>

  {#if open}
    <div class="pop">
      <div class="pop-head">
        <strong>Notifications</strong>
        {#if unread > 0}
          <button class="mark" onclick={markAll}>Mark all read</button>
        {/if}
      </div>
      <div class="list">
        {#if !items.length}
          <div class="muted empty">No notifications yet.</div>
        {:else}
          {#each items.slice(0, 30) as n (n.id)}
            <button class="item" class:unread={!n.read} onclick={() => openNotif(n)}>
              <span class="dot" class:k={n.kind}></span>
              <span class="body">
                <span class="l1">
                  <strong>{n.actor_name || "Someone"}</strong>
                  <span class="act">{kindLabel(n.kind)}</span>
                </span>
                {#if n.kind === "mention"}<span class="sub">@ you on “{n.thread_subject || "a thread"}”</span>
                {:else}<span class="sub">“{n.thread_subject || "a thread"}”</span>{/if}
                {#if n.body_snippet}<span class="snip">{n.body_snippet}</span>{/if}
                <span class="when">{timeAgo(n.created_at)}</span>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .notif {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--m3-on-surface-variant);
  }

  .bell:hover {
    background: var(--m3-row-hover);
  }

  .badge {
    position: absolute;
    top: 0;
    right: -2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--m3-error);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
  }

  .pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 80;
    width: min(360px, 92vw);
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-4);
    overflow: hidden;
  }

  /* Same anchor bug as the account menu, found by testing every popover rather
     than just the one that was reported: `right: 0` pins this panel to the
     bell, and the bell moves along the bar. At 320px the panel started 44px
     off the LEFT edge and its content was unreachable.

     Below 720px the panel is anchored to the top bar instead — `.notif` goes
     static so .topbar's existing position:relative takes over — and spans the
     viewport with an 8px gutter. Its position no longer depends on where the
     bell happens to sit. */
  @media (max-width: 720px) {
    .notif {
      position: static;
    }
    .pop {
      top: 100%;
      left: 8px;
      right: 8px;
      width: auto;
    }
  }

  .pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--m3-outline-variant);
    font: var(--m3-type-title-sm);
  }

  .mark {
    color: var(--m3-primary);
    font: var(--m3-type-label-sm);
    font-weight: 600;
  }

  .list {
    max-height: 380px;
    overflow-y: auto;
  }

  .item {
    display: flex;
    gap: 9px;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    border-bottom: 1px solid var(--m3-outline-variant);
  }

  .item.unread {
    background: var(--m3-primary-container);
  }

  .item:hover {
    background: var(--m3-row-hover);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    flex: 0 0 auto;
    background: var(--m3-on-surface-variant-2);
  }

  .dot.k.mention {
    background: var(--m3-tertiary);
  }
  .dot.k.assigned {
    background: var(--m3-secondary);
  }
  .dot.k.note {
    background: var(--m3-primary);
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .l1 {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }

  .act {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .sub {
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .snip {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
  }

  .empty {
    padding: 18px;
    text-align: center;
  }
</style>
