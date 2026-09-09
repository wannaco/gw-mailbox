<script>
  import { appState, agentInitials, slaOf } from "../lib/appState.svelte.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";

  let { thread, open, selectable, selected, onToggleSelect } = $props();

  let dragActive = $state(false);

  const tags = $derived(Array.isArray(thread.tags) ? thread.tags : []);
  const someoneComposing = $derived(
    Object.values(appState.presence).some(
      (p) => p.thread === thread.id && p.user !== appState.me?.id && p.status === "composing_reply"
    )
  );
  const assigned = $derived(
    thread.assigned_agent ? appState.users[thread.assigned_agent]?.name || thread.assigned_agent : ""
  );
  const assignedEmail = $derived(thread.assigned_agent ? appState.users[thread.assigned_agent]?.email || "" : "");
  const isMine = $derived(thread.assigned_agent && thread.assigned_agent === appState.me?.id);
  const sla = $derived(slaOf(thread));

  function openCard() {
    if (selectable) {
      onToggleSelect?.(thread.id);
    } else if (!dragActive) {
      open(thread.id);
    }
  }
</script>

<article
  class="card"
  class:composing={someoneComposing}
  class:overdue={sla?.kind === "breached"}
  class:sel={selected}
  class:selmode={selectable}
  class:dragging={dragActive}
  role="button"
  tabindex="0"
  aria-label={thread.subject || "Thread"}
  aria-pressed={selectable ? !!selected : undefined}
  draggable={!selectable}
  ondragstart={(e) => {
    if (selectable) return;
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
  {#if selectable}
    <span class="card-ck" class:on={selected}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        {#if selected}<path d="M4 12.5 10 18 20 6"/>{:else}<rect x="3" y="3" width="18" height="18" rx="5"/>{/if}
      </svg>
    </span>
  {/if}
  <div class="top">
    <h4 class="subject">{thread.subject || "(no subject)"}</h4>
    {#if (thread.message_count || 0) > 0}
      <span class="mcount" title={`${thread.message_count} message${thread.message_count === 1 ? "" : "s"}`}>{thread.message_count}</span>
    {/if}
    <span class="when">{timeAgo(thread.last_message_at)}</span>
  </div>
  <p class="snippet">{thread.snippet || ""}</p>
  <div class="meta">
    <span class="who">
      <span class="avatar" style="background:{avatarColor(thread.customer_email || thread.customer_name)}">
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
      <span class="assignee" class:mine={isMine} title={`Assigned to ${assigned}`}>
        <span class="a-ava" style="background:{avatarColor(assignedEmail || thread.assigned_agent)}">{agentInitials(assigned)}</span>
        <span class="a-name">{assigned}</span>
      </span>
    {/if}
    {#if sla}
      <span class="sla-chip" class:breached={sla.kind === "breached"} style="background:{sla.color}18;color:{sla.color}" title={sla.title}>{sla.text}</span>
    {/if}
  </div>
</article>

<style>
  .card {
    position: relative;
    background: var(--m3-surface-container-lowest);
    border: 1px solid var(--m3-outline-variant);
    border-left: 3px solid transparent;
    border-radius: var(--m3-shape-sm);
    padding: 10px 12px;
    cursor: grab;
    transition: box-shadow 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  }
  .card:hover {
    border-color: var(--m3-outline);
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

  .card.overdue {
    border-left-color: #ba1a1a;
  }

  .card.selmode {
    cursor: pointer;
  }
  .card.sel {
    outline: 2px solid var(--m3-primary);
    background: var(--m3-primary-container);
  }
  .card-ck {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: var(--m3-on-surface-variant);
    z-index: 2;
  }
  .card-ck.on {
    background: var(--m3-primary);
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

  .mcount {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    color: var(--m3-primary);
    border: 1px solid var(--m3-primary);
    border-radius: 10px;
    padding: 0 6px;
    line-height: 16px;
    white-space: nowrap;
    flex: 0 0 auto;
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
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 6px;
    padding: 1px 7px;
    font: var(--m3-type-label-sm);
  }

  .pencil {
    color: var(--m3-tertiary);
    display: inline-flex;
  }

  .assignee {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 118px;
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 6px;
    padding: 1px 7px 1px 3px;
    font: var(--m3-type-label-sm);
    overflow: hidden;
  }

  .assignee.mine {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }

  .a-ava {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: #fff;
    font-size: 8px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .a-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sla-chip {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 6px;
    padding: 1px 7px;
    white-space: nowrap;
    flex: 0 0 auto;
    margin-left: auto;
  }
  .sla-chip.breached {
    animation: sla-pulse 1.8s ease-in-out infinite;
  }
  @keyframes sla-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
</style>
