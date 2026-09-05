<script>
  import { appState } from "../lib/appState.svelte.js";

  function kindIcon(kind) {
    if (kind === "error") {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v7h-2V7zm0 9h2v2h-2v-2z"/></svg>`;
    }
    if (kind === "success") {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.5-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>`;
    }
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;
  }
</script>

<div class="snacks" role="status">
  {#each appState.toasts as t (t.id)}
    <div class="snack {t.kind}">
      <!-- svelte-ignore a11y_no_raw_html -->
      <span class="icon">{@html kindIcon(t.kind)}</span>
      <span class="msg">{t.message}</span>
      <button
        class="dismiss"
        onclick={() => {
          const i = appState.toasts.findIndex((x) => x.id === t.id);
          if (i >= 0) appState.toasts.splice(i, 1);
        }}
      >✕</button>
    </div>
  {/each}
</div>

<style>
  .snacks {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 100;
    width: min(560px, calc(100vw - 32px));
    pointer-events: none;
  }

  .snack {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 12px 14px;
    border-radius: var(--m3-shape-xs);
    background: var(--m3-inverse-surface);
    color: var(--m3-inverse-on-surface);
    box-shadow: var(--m3-elev-3);
    font: var(--m3-type-body-md);
    animation: rise 0.18s ease;
  }

  .snack.error {
    background: var(--m3-error);
    color: var(--m3-on-error);
  }

  .snack.success {
    background: #0f5132;
    color: #fff;
  }

  .icon {
    display: inline-flex;
  }

  .msg {
    flex: 1;
  }

  .dismiss {
    color: inherit;
    opacity: 0.8;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 50%;
  }

  .dismiss:hover {
    background: rgb(255 255 255 / 0.15);
  }

  @keyframes rise {
    from {
      transform: translateY(10px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
