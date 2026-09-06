<script>
  import { appState, statusMeta, threadUnread } from "../lib/appState.svelte.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";
  import { agentInitials } from "../lib/appState.svelte.js";

  let { open } = $props();

  // Same filtering/sorting as the board, but rendered as a Gmail-like list.
  const rows = $derived(
    Object.values(appState.threads)
      .filter((t) => t.inbox === appState.activeInboxId)
      .filter((t) => {
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

  const counts = $derived(
    rows.reduce((acc, t) => {
      const s = t.status || "new";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {})
  );

  // Unread-ish: new + escalated threads render bold, like Gmail.
  const isHot = (t) => t.status === "new" || t.status === "escalated";
  const msgCount = (t) => t.message_count || 0;
  const isUnread = (t) => threadUnread(t.id) > 0;

  const composingOf = (threadId) =>
    Object.values(appState.presence).find(
      (p) => p.thread === threadId && p.user !== appState.me?.id && p.status === "composing_reply"
    );

  const assignedName = (t) =>
    t.assigned_agent ? appState.users[t.assigned_agent]?.name || t.assigned_agent : "";
</script>

<div class="list-wrap">
  <div class="toolbar">
    <span class="count">{rows.length} conversations</span>
    <button class="md3-chip" class:is-active={appState.onlyMine} onclick={() => (appState.onlyMine = !appState.onlyMine)}>My tickets</button>
    {#each ["new", "in_progress", "waiting_customer", "escalated", "closed"] as st (st)}
      {#if (counts[st] || 0) > 0}
        <span class="mini-chip" style="--dot:{statusMeta(st).dot}">
          <span class="dot"></span>{statusMeta(st).label} {counts[st]}
        </span>
      {/if}
    {/each}
  </div>

  <div class="list">
    {#if !rows.length}
      <div class="empty">
        <p>No conversations{appState.search ? " match your search" : ""}.</p>
      </div>
    {/if}

    {#each rows as t (t.id)}
      {@const comp = composingOf(t.id)}
      <button
        class="row"
        class:hot={isHot(t)}
        class:unread={isUnread(t)}
        onclick={() => open(t.id)}
        aria-label={t.subject || "Thread"}
      >
        <span class="avatar" style="background:{avatarColor(t.customer_email || t.customer_name)}">
          {agentInitials(t.customer_name || t.customer_email)}
        </span>

        <span class="mid">
          <span class="top">
            {#if isUnread(t)}
              <span class="unread-dot" title="New messages"></span>
            {/if}
            <span class="subject">{t.subject || "(no subject)"}</span>
            {#if msgCount(t) > 0}
              <span class="mcount" class:unread={isUnread(t)} title={`${msgCount(t)} message${msgCount(t) === 1 ? "" : "s"}`}>{msgCount(t)}</span>
            {/if}
            {#each (Array.isArray(t.tags) ? t.tags : []).slice(0, 3) as tag (tag)}
              <span class="tag">{tag}</span>
            {/each}
            {#if comp}
              <span class="pencil" title={`${comp.agentName || "Someone"} is drafting a reply`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
              </span>
            {/if}
          </span>
          <span class="snip">
            <span class="from">{t.customer_name || t.customer_email || "—"}</span>
            <span class="snippet-text">{t.snippet || ""}</span>
          </span>
          {#if assignedName(t)}
            <span class="assignee-pill" class:mine={t.assigned_agent === appState.me?.id} title={`Assigned to ${assignedName(t)}`}>
              <span class="ap-ava" style="background:{avatarColor(t.assigned_agent)}">{agentInitials(assignedName(t))}</span>
              <span class="ap-name">{assignedName(t)}</span>
            </span>
          {/if}
        </span>

        <span class="right">
          <span class="when">{timeAgo(t.last_message_at)}</span>
          <span class="status-pill" style="background:{statusMeta(t.status).dot}22;color:{statusMeta(t.status).dot}">
            {statusMeta(t.status).label}
          </span>
        </span>
      </button>
    {/each}
  </div>
</div>

<style>
  .list-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px 8px;
    flex-wrap: wrap;
  }

  .count {
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface-variant-2);
    margin-right: 4px;
  }

  .mini-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .mini-chip .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--dot, #888);
    display: inline-block;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 16px 16px;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    text-align: left;
    padding: 10px 14px;
    border-radius: var(--m3-shape-sm);
    border-bottom: 1px solid var(--m3-outline-variant);
    border-radius: 0;
    cursor: pointer;
  }

  .row:hover {
    background: var(--m3-row-hover);
  }

  .row:focus-visible {
    outline: 2px solid var(--m3-primary);
    outline-offset: -2px;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    flex: 0 0 auto;
    letter-spacing: 0.02em;
  }

  .mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .subject {
    font: var(--m3-type-body-lg);
    font-weight: 400;
    color: var(--m3-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.hot .subject,
  .row.unread .subject {
    font-weight: 600;
    color: var(--m3-on-surface);
  }

  .unread-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--m3-primary);
    flex: 0 0 auto;
  }

  .mcount {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    border: 1px solid var(--m3-outline-variant);
    border-radius: 10px;
    padding: 0 6px;
    line-height: 16px;
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .mcount.unread {
    color: var(--m3-primary);
    border-color: var(--m3-primary);
    font-weight: 600;
  }

  .tag {
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    border-radius: 4px;
    padding: 1px 7px;
    font: var(--m3-type-label-sm);
    white-space: nowrap;
  }

  .pencil {
    color: var(--m3-tertiary);
    display: inline-flex;
  }

  .snip {
    display: flex;
    gap: 8px;
    min-width: 0;
    align-items: baseline;
  }

  .from {
    font: var(--m3-type-body-md);
    font-weight: 600;
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .snippet-text {
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.hot .from {
    color: var(--m3-on-surface);
  }

  .assignee-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    background: var(--m3-secondary-container);
    color: var(--m3-on-secondary-container);
    border-radius: 999px;
    padding: 1px 9px 1px 3px;
    font: var(--m3-type-label-sm);
    font-weight: 500;
    max-width: 100%;
  }

  .assignee-pill.mine {
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }

  .ap-ava {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    color: #fff;
    font-size: 8px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .ap-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 5px;
    flex: 0 0 auto;
  }

  .when {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    white-space: nowrap;
  }

  .status-pill {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    border-radius: 4px;
    padding: 1px 7px;
    white-space: nowrap;
  }

  .empty {
    text-align: center;
    color: var(--m3-on-surface-variant-2);
    padding: 48px 0;
    font: var(--m3-type-body-md);
  }
</style>
