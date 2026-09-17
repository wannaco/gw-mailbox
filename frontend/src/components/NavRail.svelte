<script>
  import { appState } from "../lib/appState.svelte.js";

  let { select } = $props();
</script>

<nav class="rail" aria-label="Inboxes">
  <div class="rail-head">Mailboxes</div>
  <div class="rail-inner">
    {#each appState.inboxes as inbox (inbox.id)}
      <button
        class="rail-item"
        class:active={appState.activeInboxId === inbox.id}
        onclick={() => select(inbox.id)}
        title={inbox.email_address}
        aria-current={appState.activeInboxId === inbox.id ? "true" : undefined}
      >
        <span class="rail-icon" aria-hidden="true">
          <!-- Inbox glyph rather than the mailbox's initials: two letters in a
               box read as an avatar (a person), which is the wrong idea — a
               mailbox is a place. The name is right next to it anyway, so the
               initials were saying nothing the label didn't. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z"/>
          </svg>
        </span>
        <span class="rail-label">{inbox.name}</span>
      </button>
    {/each}
    {#if !appState.inboxes.length}
      <div class="empty">No inboxes assigned yet.<br /><small>Ask an admin to add you to an inbox.</small></div>
    {/if}
  </div>
</nav>

<style>
  /* ---------------------------------------------------------------------------
     Desktop sidebar.

     This used to be a 128px strip of *centred, stacked* icon-over-label tiles —
     which is a mobile bottom-tab-bar pattern, not a desktop sidebar. On a
     desktop it read as a phone dock pinned to the left edge: 83px-tall rows to
     convey one word, the label truncated on a centre axis, and an active state
     that was a grey blob with a competing blue icon.

     It's now a normal sidebar list: a section label, then full-width rows with
     the icon and name on ONE line, Gmail's own selected-row tint, and a
     primary-coloured icon marking the current mailbox. Row height drops from
     83px to 38px, so the rail stops eating vertical space it wasn't using.
     --------------------------------------------------------------------------- */
  .rail {
    width: 208px;
    flex: 0 0 208px;
    background: var(--m3-surface-container-lowest);
    border-right: 1px solid var(--m3-outline-variant);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .rail-head {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--m3-on-surface-variant-2);
    padding: 14px 16px 6px;
    flex: 0 0 auto;
  }

  .rail-inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 10px 12px;
    overflow-y: auto;
  }

  .rail-item {
    width: 100%;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: var(--m3-shape-sm);
    color: var(--m3-on-surface-variant);
    text-align: left;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .rail-item:hover {
    background: var(--m3-row-hover);
    color: var(--m3-on-surface);
  }

  /* Matches the list view's selected-row tint, so "current" means the same
     thing everywhere in the app. The icon carries the accent; the row itself
     stays calm — two competing emphases was part of what looked wrong. */
  .rail-item.active {
    background: var(--m3-row-active);
    color: var(--m3-on-surface);
  }

  .rail-icon {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    border-radius: var(--m3-shape-sm);
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    transition: background 0.12s ease, color 0.12s ease;
  }

  /* Glyph is 16px inside the 26px chip — same optical weight as the 20px
     toolbar icons, without the chip reading as a button. */
  .rail-icon svg {
    display: block;
  }

  .rail-item.active .rail-icon {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }

  .rail-label {
    font: var(--m3-type-label-lg);
    font-weight: 500;
    line-height: 1.2;
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-item.active .rail-label {
    font-weight: 600;
  }

  .empty {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    padding: 12px 6px;
  }

  /* ---------------------------------------------------------------------------
     Below 720px the rail becomes the bottom bar again — and there, stacked
     icon-over-label IS the right pattern, so the mobile layout keeps one line
     per mailbox at a small size and scrolls horizontally.
     --------------------------------------------------------------------------- */
  @media (max-width: 720px) {
    .rail {
      width: 100%;
      flex: 0 0 auto;
      flex-direction: row;
      border-right: 0;
      border-top: 1px solid var(--m3-outline-variant);
      order: 10;
    }

    .rail-head {
      display: none;
    }

    .rail-inner {
      flex-direction: row;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 6px 8px;
    }

    .rail-item {
      width: auto;
      flex: 0 0 auto;
      gap: 7px;
      padding: 0 10px;
      height: 34px;
    }

    .rail-icon {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
    }

    .rail-icon svg {
      width: 14px;
      height: 14px;
    }

    .rail-label {
      flex: 0 0 auto;
      max-width: none;
      font-size: 0.8125rem;
    }
  }
</style>
