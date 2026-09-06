<script>
  import { appState, agentInitials } from "../lib/appState.svelte.js";

  let { select } = $props();
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
        <span class="rail-icon">{agentInitials(inbox.name)}</span>
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
    width: 128px;
    flex: 0 0 128px;
    background: var(--m3-surface);
    border-right: 1px solid var(--m3-outline-variant);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .rail-inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 10px;
    overflow-y: auto;
  }

  .rail-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 6px;
    border-radius: var(--m3-shape-md);
    color: var(--m3-on-surface-variant);
    transition: background 0.15s ease;
  }

  .rail-item:hover {
    background: var(--m3-surface-container-high);
  }

  .rail-item.active {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }

  .rail-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 12px;
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-title-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .rail-item.active .rail-icon {
    background: var(--m3-primary);
    color: var(--m3-on-primary);
  }

  .rail-label {
    font: var(--m3-type-label-sm);
    text-align: center;
    line-height: 1.2;
    max-width: 108px;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-item.active .rail-label {
    font-weight: 600;
  }

  .rail-item {
    width: 84px;
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
      padding: 6px 8px;
    }

    .rail-item {
      width: auto;
      flex-direction: row;
      gap: 6px;
      padding: 6px 10px;
    }

    .rail-icon {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      font-size: 0.72rem;
    }

    .rail-label {
      white-space: nowrap;
      max-width: none;
    }
  }
</style>
