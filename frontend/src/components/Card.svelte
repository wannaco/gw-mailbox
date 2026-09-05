<script>
  import { state, agentInitials } from "../lib/state.svelte.js";
  import { timeAgo } from "../lib/utils.js";

  let { thread, open } = $props();

  let dragActive = $state(false);

  const tags = $derived(Array.isArray(thread.tags) ? thread.tags : []);
  const someoneComposing = $derived(
    Object.values(state.presence).some(
      (p) => p.thread === thread.id && p.user !== state.me?.id && p.status === "composing_reply"
    )
  );
  const assigned = $derived(
    thread.assigned_agent ? state.users[thread.assigned_agent]?.name || thread.assigned_agent : ""
  );

  function openCard() {
    if (!dragActive) open(thread.id);
  }
</script>

<article
  class="card"
  class:composing={someoneComposing}
  class:dragging={dragActive}
  role="button"
  tabindex="0"
  aria-label={thread.subject || "Thread"}
  draggable="true"
  ondragstart={(e) => {
    e.dataTransfer.setData("text/plain", thread.id);
    e.dataTransfer.effectAllowed = "move";
    dragActive = true;
  }}
  ondragend={() => (dragActive = false)}
  onclick={openCard}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openCard();
    }
  }}
>
  <div class="top">
    <h4 class="subject">{thread.subject || "(no subject)"}</h4>
    <span class="when">{timeAgo(thread.last_message_at)}</span>
  </div>
  <p class="snippet">{thread.snippet || ""}</p>
  <div class="meta">
    <span class="who">
      <span class="avatar" style="background:hsl({(thread.customer_email || 'x').charCodeAt(0) * 47 % 360} 55% 40%)">
        {agentInitials(thread.customer_name || thread.customer_email)}
      </span>
      <span class="email" title={thread.customer_email}>{thread.customer_email || "—"}</span>
    </span>
    {#each tags.slice(0, 2) as tag (tag)}
      <span class="tag-chip">#{tag}</span>
    {/each}
    {#if someoneComposing}
      <span class="pencil" title="Someone is drafting a reply">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </span>
    {/if}
    {#if assigned}
      <span class="assignee" title={`Assigned: ${assigned}`}>{agentInitials(assigned)}</span>
    {/if}
  </div>
</article>

<style>
  .card {
    background: var(--m3-surface-container-low);
    border-radius: var(--m3-shape-md);
    box-shadow: var(--m3-elev-1);
    padding: 10px 12px;
    cursor: grab;
    transition: box-shadow 0.15s ease, opacity 0.15s ease;
    border-left: 3px solid transparent;
  }

  .card:hover {
    box-shadow: var(--m3-elev-2);
  }

  .card:focus-visible {
    outline: 2px solid var(--m3-primary);
    outline-offset: 1px;
  }

  .card.dragging {
    opacity: 0.45;
    box-shadow: var(--m3-elev-3);
  }

  .card.composing {
    border-left-color: var(--m3-tertiary);
  }

  .top {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .subject {
    flex: 1;
    font: var(--m3-type-title-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }

  .snippet {
    margin: 4px 0 8px;
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface-variant);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .who {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .email {
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-chip {
    background: var(--m3-surface-container-highest);
    color: var(--m3-on-surface-variant);
    border-radius: var(--m3-shape-full);
    padding: 1px 8px;
    font: var(--m3-type-label-sm);
  }

  .pencil {
    color: var(--m3-tertiary);
    display: inline-flex;
  }

  .assignee {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--m3-secondary);
    color: var(--m3-on-secondary);
    font-size: 9px;
    font-weight: 700;
  }
</style>
