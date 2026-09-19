<script>
  import { appState, agentInitials, userName } from "../lib/appState.svelte.js";
  import { avatarColor } from "../lib/utils.js";

  // Always-on presence control: my avatar (green dot) + others online. No
  // flash — the pill renders whenever a session is active, self always present.
  let open = $state(false);

  function describe(p) {
    if (p.status === "composing_reply") return "composing a reply" + (p.thread_subject ? " on “" + p.thread_subject + "”" : "");
    if (p.status === "viewing") return "viewing" + (p.thread_subject ? " “" + p.thread_subject + "”" : " a thread");
    return "online";
  }

  const me = $derived({
    name: appState.me?.name || appState.me?.email || "",
    email: appState.me?.email || "",
    status: appState.myActivity?.status || "online"
  });

  const others = $derived((appState.roster || []).filter((p) => p && (p.name || p.email)));
  const total = $derived(1 + others.length); // self + others
</script>

<div class="roster">
  <button class="roster-btn" onclick={() => (open = !open)} title="Who's online" aria-expanded={open}>
    <span class="live-dot"></span>
    <span class="roster-label">ONLINE</span>
    <span class="me-avatar" style="background:{avatarColor(me.email || me.name)}">
      {agentInitials(me.name)}
      <span class="green-dot"></span>
    </span>
    {#if others.length > 0}
      {#each others.slice(0, 4) as p (p.actor)}
        <span class="o-avatar" style="background:{avatarColor(p.email || p.name)}">
          {agentInitials(p.name || p.email)}
          {#if p.status === "composing_reply"}<span class="typing-dot"></span>{/if}
        </span>
      {/each}
      <span class="count">{total}</span>
    {:else}
      <span class="alone">alone</span>
    {/if}
  </button>

  {#if open}
    <div class="pop" role="menu">
      <div class="pop-title">Online now</div>
      <div class="row">
        <span class="me-avatar" style="background:{avatarColor(me.email || me.name)}">{agentInitials(me.name)}<span class="green-dot"></span></span>
        <span class="who"><strong>{me.name}</strong><span class="act muted">you — {describe(me)}</span></span>
      </div>
      {#if others.length}
        {#each others as p (p.actor)}
          <div class="row">
            <span class="o-avatar" style="background:{avatarColor(p.email || p.name)}">{agentInitials(p.name || p.email)}{#if p.status === "composing_reply"}<span class="typing-dot"></span>{/if}</span>
            <span class="who"><strong>{p.name || p.email}</strong><span class="act muted">{describe(p)}</span></span>
          </div>
        {/each}
      {:else}
        <div class="muted" style="padding:4px 2px">No one else is online right now.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .roster {
    position: relative;
    display: inline-flex;
    align-items: center;
    margin-left: 2px;
  }

  .roster-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--m3-surface-container-high);
    cursor: pointer;
  }

  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
  }

  .roster-label {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--m3-primary);
  }

  .me-avatar,
  .o-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    border: 2px solid var(--m3-surface-container);
  }

  .green-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    border: 2px solid var(--m3-surface-container);
  }

  .typing-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--m3-tertiary);
    border: 2px solid var(--m3-surface-container);
  }

  .count {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
    font-weight: 700;
  }

  .alone {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
  }

  /* Mobile: collapse to just the avatar stack + count.
   *
   * The pill measured 166px at 412px wide — dot (7) + "ONLINE" (65) + avatar
   * (22) + "alone" (41) plus gaps — which is the single widest control in the
   * top bar. That pushed the row past the viewport, so the notification bell
   * wrapped onto its own line and the account chip onto a third. Removing the
   * wordmark and the "alone" label frees ~106px, leaving every control on one
   * line with room to spare. The full status is still one tap away in the
   * popup, so nothing is actually lost. */
  @media (max-width: 720px) {
    .roster-label,
    .alone {
      display: none;
    }
    .roster-btn {
      gap: 4px;
      padding: 3px 6px;
    }

    /* Same anchor bug the account menu had: the popup was pinned to the pill
       with right:0, and the pill moves along the bar, so at 320px the roster
       panel started 12px off the left edge. Anchored to the top bar below
       720px instead (`.roster` goes static, letting .topbar's position:relative
       take over) with an 8px gutter. */
    .roster {
      position: static;
    }
    .pop {
      top: 100%;
      left: 8px;
      right: 8px;
      min-width: 0;
    }

    /* CAP THE AVATAR STACK.
     *
     * The pill renders up to four teammate avatars, so it grows with the team:
     * 1 other = 85px, 5 others = 163px. At 163px a 360px bar cannot fit the
     * brand, gear, theme, pill, bell and account chip on one line — it wrapped
     * to three rows again, which is exactly the original bug coming back via a
     * different input. An unbounded element in a fixed-width bar has to be
     * capped; that is the actual fix, not another breakpoint tweak.
     *
     * Child order inside .roster-btn is fixed, and display:none elements still
     * count for nth-child, so the selectors are stable:
     *   1 .live-dot  2 .roster-label  3 .me-avatar  4+ .o-avatar  last .count
     */
    .o-avatar:nth-child(n + 6) {
      display: none; /* keep at most two teammate avatars */
    }
  }

  @media (max-width: 380px) {
    /* Narrowest phones: no teammate avatars at all, the count carries it. */
    .o-avatar {
      display: none;
    }
  }

  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 70;
    min-width: 220px;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-4);
    padding: 8px;
  }

  .pop-title {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--m3-on-surface-variant);
    padding: 0 2px 6px;
    border-bottom: 1px solid var(--m3-outline-variant);
    margin-bottom: 6px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
  }

  .who {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
  }

  .act {
    font: var(--m3-type-label-sm);
  }

  .muted {
    color: var(--m3-on-surface-variant);
  }
</style>
