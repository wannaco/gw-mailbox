<script>
  import { appState, agentInitials } from "../lib/appState.svelte.js";
  import { avatarColor } from "../lib/utils.js";

  // Who else is on this thread, for the LIST and BOARD views.
  //
  // Sourced from the app-wide roster (agent_presence), not thread_presence:
  // thread_presence rows are only ever fetched for a thread you have opened, so
  // using them here would show nothing until you clicked in. The roster carries
  // each agent's current `thread` and `status` and is polled every ~8s, so it
  // covers every row on screen without a single extra request.
  let { threadId, max = 2 } = $props();

  const here = $derived(
    (appState.roster || []).filter((r) => r && r.thread === threadId && r.status !== "online")
  );
  const shown = $derived(here.slice(0, max));
  const extra = $derived(Math.max(0, here.length - shown.length));

  const label = $derived(
    here.length
      ? here
          .map((r) => `${r.name || r.email || "Someone"} is ${r.status === "composing_reply" ? "drafting a reply" : "viewing"}`)
          .join(" · ")
      : ""
  );
</script>

{#if shown.length}
  <span class="tp" title={label} aria-label={label}>
    {#each shown as r (r.actor)}
      <span class="tp-a" style="background:{avatarColor(r.email || r.name)}">
        {agentInitials(r.name || r.email)}
        {#if r.status === "composing_reply"}<span class="tp-pen" aria-hidden="true"></span>{/if}
      </span>
    {/each}
    {#if extra}<span class="tp-more">+{extra}</span>{/if}
  </span>
{/if}

<style>
  .tp {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
  }

  /* Overlapped, with a ring in the surrounding surface colour so the stack
     reads as a group rather than as separate chips. */
  .tp-a {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 19px;
    height: 19px;
    border-radius: 50%;
    color: #fff;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.02em;
    box-shadow: 0 0 0 2px var(--m3-surface-raised, var(--m3-surface-container-lowest));
  }
  .tp-a + .tp-a {
    margin-left: -7px;
  }

  /* Composing is the state that actually matters (it locks the composer), so it
     gets a second cue beyond the initials. */
  .tp-pen {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--m3-tertiary);
    box-shadow: 0 0 0 2px var(--m3-surface-raised, var(--m3-surface-container-lowest));
  }

  .tp-more {
    margin-left: -6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 19px;
    height: 19px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--m3-surface-container-high);
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-sm);
    font-weight: 700;
    box-shadow: 0 0 0 2px var(--m3-surface-raised, var(--m3-surface-container-lowest));
  }
</style>
