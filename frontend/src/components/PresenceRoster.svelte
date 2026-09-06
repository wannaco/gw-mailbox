<script>
  import { appState, agentInitials } from "../lib/appState.svelte.js";
  import { avatarColor } from "../lib/utils.js";

  // Human-readable status line for a roster member.
  function describe(p) {
    if (p.status === "composing_reply") return "composing a reply" + (p.thread_subject ? " on “" + p.thread_subject + "”" : "");
    if (p.status === "viewing") return "viewing" + (p.thread_subject ? " “" + p.thread_subject + "”" : " a thread");
    return "online";
  }

  const online = $derived((appState.roster || []).filter((p) => p && p.name || p.email));
</script>

{#if online.length}
  <div class="roster" role="status" title={online.map((p) => `${p.name || p.email} — ${describe(p)}`).join("\n")}>
    <span class="roster-label">ONLINE</span>
    {#each online.slice(0, 5) as p (p.actor)}
      <span
        class="r-avatar"
        class:composing={p.status === "composing_reply"}
        style="background:{avatarColor(p.email || p.name)}"
        title={`${p.name || p.email} — ${describe(p)}`}
      >{agentInitials(p.name || p.email)}{#if p.status === "composing_reply"}<span class="dot"></span>{/if}</span>
    {/each}
    {#if online.length > 5}
      <span class="more">+{online.length - 5}</span>
    {/if}
  </div>
{/if}

<style>
  .roster {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    margin-left: 2px;
    border-radius: 999px;
    background: var(--m3-surface-container-high);
  }

  .roster-label {
    font: var(--m3-type-label-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--m3-primary);
    margin-right: 3px;
  }

  .r-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    border: 2px solid var(--m3-surface-container);
  }

  .r-avatar .dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--m3-tertiary);
    border: 2px solid var(--m3-surface-container);
  }

  .more {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }
</style>
