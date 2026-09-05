<script>
  import { appState, agentInitials } from "../lib/appState.svelte.js";

  let { select } = $props();

  function inboxHue(id) {
    return (id || "0").charCodeAt(0) * 137 % 360;
  }
</script>

<nav class="rail" aria-label="Inboxes">
  <div class="rail-inner">
    {#each appState.inboxes as inbox (inbox.id)}
      <button
        class="rail-item"
        class:active={appState.activeInboxId === inbox.id}
        onclick={() => select(inbox.id)}
        title={inbox.email_address}
      >
        <span class="rail-dot" style="background:hsl({inboxHue(inbox.id)} 65% 46%)"></span>
        <span class="rail-label">{inbox.name}</span>
      </button>
    {/each}
    {#if !appState.inboxes.length}
      <div class="empty">No inboxes assigned yet.<br /><small>Ask an admin to add you to an inbox.</small></div>
    {/if}
  </div>
</nav>

<style>
  .rail {
    width: 92px;
    flex: 0 0 92px;
    background: var(--m3-surface);
    border-right: 1px solid var(--m3-outline-variant);
    display: flex;
    flex-direction: column;
  }

  .rail-inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 6px;
    overflow-y: auto;
  }

  .rail-item {
    width: 80px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    border-radius: var(--m3-shape-md);
    color: var(--m3-on-surface-variant);
  }

  .rail-item:hover {
    background: var(--m3-surface-container-low);
  }

  .rail-item.active {
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    font-weight: 600;
  }

  .rail-dot {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    display: block;
  }

  .rail-label {
    font: var(--m3-type-label-sm);
    text-align: center;
    line-height: 1.15;
    max-width: 74px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    text-align: center;
    padding: 12px 6px;
  }

  @media (max-width: 720px) {
    .rail {
      width: 100%;
      flex: 0 0 auto;
      flex-direction: row;
      border-right: 0;
      border-top: 1px solid var(--m3-outline-variant);
      order: 10;
    }

    .rail-inner {
      flex-direction: row;
      overflow-x: auto;
      padding: 6px;
    }

    .rail-item {
      width: auto;
      flex-direction: row;
    }

    .rail-label {
      white-space: nowrap;
      max-width: none;
    }
  }
</style>
