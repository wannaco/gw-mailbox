<script>
  import { appState, agentInitials, slaOf, threadUnread, threadUnreadNotes } from "../lib/appState.svelte.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";
  import ThreadPresence from "./ThreadPresence.svelte";

  let { thread, open, selectable, selected, onToggleSelect, onDragStart, onDragEnd } = $props();

  let dragActive = $state(false);
  // Suppress the click that follows a drag: without this, dropping a card also
  // opened the thread drawer (dragend fires before click).
  let justDragged = false;

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
  const unread = $derived(threadUnread(thread.id) > 0);
  const customer = $derived(thread.customer_name || thread.customer_email || "—");
  function labelColor(name) {
    const hit = (appState.labels || []).find((l) => l.name === name);
    return (hit && hit.color) || "#9aa0a6";
  }
  // Unread internal notes — see ListView for why this is a separate, filled
  // badge rather than reusing the message count.
  const unreadNotes = $derived(threadUnreadNotes(thread.id));

  function openCard() {
    if (selectable) {
      onToggleSelect?.(thread.id);
    } else if (!dragActive && !justDragged) {
      open(thread.id);
    }
  }
</script>

<!-- A div with role="button": <article> may not take the button role. No
     aria-label — the visible text (subject, customer, snippet) is the name,
     so what a screen reader announces matches what is on the card. -->
<div
  data-id={thread.id}
  aria-describedby="board-kbd-help"
  class="card"
  class:composing={someoneComposing}
  class:overdue={sla?.kind === "breached"}
  class:unread
  class:sel={selected}
  class:selmode={selectable}
  class:dragging={dragActive}
  role="button"
  tabindex="0"
  aria-pressed={selectable ? !!selected : undefined}
  draggable={!selectable}
  ondragstart={(e) => {
    if (selectable) return;
    e.dataTransfer.setData("text/plain", thread.id);
    e.dataTransfer.effectAllowed = "move";
    dragActive = true;
    onDragStart?.(thread.id);
  }}
  ondragend={() => {
    dragActive = false;
    justDragged = true;
    setTimeout(() => (justDragged = false), 220);
    onDragEnd?.();
  }}
  onclick={openCard}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openCard();
    }
  }}
>
  {#if selectable}
    <span class="card-ck" class:on={selected} aria-hidden="true">
      {#if selected}<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>{/if}
    </span>
  {/if}

  <div class="c-top">
    {#if unread}<span class="udot" title="New messages"></span>{/if}
    <span class="subject">{thread.subject || "(no subject)"}</span>
    <span class="when">{timeAgo(thread.last_message_at)}</span>
  </div>

  {#if thread.snippet}<p class="snippet">{thread.snippet}</p>{/if}

  {#if tags.length}
    <div class="tags">
      {#each tags.slice(0, 3) as tag (tag)}
        <span class="tag" style="--tag:{labelColor(tag)}"><span class="tdot"></span><span class="tname">{tag}</span></span>
      {/each}
      {#if tags.length > 3}<span class="tag more" title={tags.slice(3).join(", ")}>+{tags.length - 3}</span>{/if}
    </div>
  {/if}

  <div class="c-foot">
    <span class="who">
      <span class="avatar" style="background:{avatarColor(thread.customer_email || thread.customer_name)}" aria-hidden="true">
        {agentInitials(thread.customer_name || thread.customer_email)}
      </span>
      <span class="cname" title={thread.customer_email}>{customer}</span>
    </span>
    {#if (thread.message_count || 0) > 1}
      <span class="mcount" title={`${thread.message_count} messages`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>
        {thread.message_count}
      </span>
    {/if}
    {#if unreadNotes > 0}
      <span class="ncount" title={`${unreadNotes} unread internal note${unreadNotes === 1 ? "" : "s"}`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-3 11H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
        {unreadNotes}
      </span>
    {/if}
    {#if someoneComposing}
      <span class="pencil" title="Someone is drafting a reply">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </span>
    {/if}
    <ThreadPresence threadId={thread.id} max={2} />
    {#if assigned}
      <span class="a-ava" class:mine={isMine} style="background:{avatarColor(assignedEmail || thread.assigned_agent)}" title={`Assigned to ${isMine ? "you" : assigned}`}>
        <span aria-hidden="true">{agentInitials(assigned)}</span>
        <span class="sr-only">Assigned to {isMine ? "you" : assigned}</span>
      </span>
    {/if}
  </div>

  {#if sla}
    <span class="sla-chip" class:breached={sla.kind === "breached"} style="--c:{sla.color};--ci:{sla.ink}" title={sla.title}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4V7h-2v6.2l4.6 2.8 1-1.7-3.6-1.9z"/></svg>
      {sla.text}
    </span>
  {/if}
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 70%, transparent);
    border-radius: var(--m3-shape-md);
    padding: 11px 12px 10px;
    box-shadow: 0 1px 2px rgb(15 40 80 / 0.06);
    cursor: grab;
    transition: box-shadow 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
  }
  @media (hover: hover) {
    .card:hover { box-shadow: var(--m3-elev-2); border-color: var(--m3-outline-variant); }
  }
  .card:focus-visible { outline: 2px solid var(--m3-primary); outline-offset: 2px; }
  .card.dragging { opacity: 0.5; transform: rotate(1.5deg); box-shadow: var(--m3-elev-3); }
  /* Left accent: red for an overdue SLA, violet while someone is drafting. */
  .card.overdue { box-shadow: inset 3px 0 0 var(--sla-breached), 0 1px 2px rgb(15 40 80 / 0.06); }
  .card.composing { box-shadow: inset 3px 0 0 var(--m3-tertiary), 0 1px 2px rgb(15 40 80 / 0.06); }
  .card.selmode { cursor: pointer; padding-right: 36px; }
  .card.sel {
    background: var(--m3-row-active);
    border-color: color-mix(in srgb, var(--m3-primary) 55%, transparent);
  }
  .card-ck {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-grid;
    place-content: center;
    border: 1.5px solid var(--m3-outline);
    background: var(--m3-surface-raised);
    color: var(--m3-on-primary);
  }
  .card-ck.on { background: var(--m3-primary); border-color: var(--m3-primary); }

  .c-top { display: flex; align-items: flex-start; gap: 8px; }
  .udot {
    width: 7px;
    height: 7px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--m3-primary);
    flex: none;
  }
  /* Two lines, not one: a 256px lane cut subjects to "Quote requ…". */
  .subject {
    flex: 1;
    min-width: 0;
    font: var(--m3-type-body-md);
    font-weight: 500;
    line-height: 1.35;
    color: var(--m3-on-surface);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .card.unread .subject { font-weight: 650; }
  .when {
    flex: none;
    margin-top: 1px;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .card.unread .when { color: var(--m3-on-surface); font-weight: 600; }

  .snippet {
    margin: 0;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    max-width: 100%;
    padding: 0 7px 0 6px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }
  .tdot { width: 6px; height: 6px; border-radius: 50%; background: var(--tag); flex: none; }
  .tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag.more { padding: 0 6px; color: var(--m3-on-surface-variant-2); }

  .c-foot { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 2px; }
  .who { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .avatar, .a-ava {
    display: inline-grid;
    place-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 8.5px;
    font-weight: 700;
    flex: none;
  }
  .a-ava.mine { box-shadow: 0 0 0 2px var(--m3-surface-raised), 0 0 0 3.5px var(--m3-primary); }
  .cname {
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mcount, .ncount {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .mcount { color: var(--m3-on-surface-variant-2); background: var(--m3-surface-container); }
  .ncount { color: var(--m3-on-tertiary-container); background: var(--m3-tertiary-container); font-weight: 700; }
  .pencil { color: var(--m3-tertiary); display: inline-flex; flex: none; }

  .sla-chip {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px 0 6px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ci);
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .sla-chip.breached { animation: sla-pulse 1.8s ease-in-out infinite; }
  @keyframes sla-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
</style>
