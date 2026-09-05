<script>
  import { onMount } from "svelte";
  import { state, toast, resetSession, agentInitials } from "./lib/state.svelte.js";
  import * as api from "./lib/api.js";
  import Login from "./components/Login.svelte";
  import NavRail from "./components/NavRail.svelte";
  import Board from "./components/Board.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Snackbar from "./components/Snackbar.svelte";

  let theme = $state("dark");

  function applyTheme() {
    const saved = localStorage.getItem("gwmb.theme");
    theme = saved || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  }
  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("gwmb.theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  onMount(async () => {
    applyTheme();
    const t = api.savedToken();
    if (!t) return;
    state.token = t;
    try {
      await api.loadSession();
      api.startRealtime();
    } catch {
      logout();
      toast("error", "Session expired — sign in again");
    }
  });

  async function handleLogin(email, password) {
    const res = await api.authWithPassword(email, password);
    state.token = res.token;
    localStorage.setItem("gwmb.token", res.token);
    await api.loadSession();
    api.startRealtime();
  }

  function logout() {
    api.stopRealtime();
    resetSession();
    localStorage.removeItem("gwmb.token");
  }

  async function switchInbox(id) {
    state.activeInboxId = id;
    state.openThreadId = "";
    await api.refreshThreads();
  }
</script>

<svelte:head>
  <title>{state.me ? "Mailbox" : "Sign in"} — shared inbox & kanban</title>
</svelte:head>

{#if !state.me}
  <Login {handleLogin} />
{:else}
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span class="brand-name">Mailbox</span>
      </div>
      <div class="spacer"></div>
      <span class="md3-chip is-active">{state.inboxes.find((i) => i.id === state.activeInboxId)?.name || "—"}</span>
      <button class="md3-icon-btn" title="Toggle theme" onclick={toggleTheme}>
        {#if theme === "dark"}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>
        {:else}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-12V3m0 18v-2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M3 12h2m14 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        {/if}
      </button>
      <div class="me">
        <span class="avatar" style="background:hsl({(state.me?.id || '0').charCodeAt(0) * 47 % 360} 60% 42%)">
          {agentInitials(state.me?.name || state.me?.email)}
        </span>
        <span class="me-name">{state.me?.name || state.me?.email}</span>
        <button class="md3-icon-btn" title="Sign out" onclick={logout}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
        </button>
      </div>
    </header>

    <div class="body">
      <NavRail select={switchInbox} />
      <main class:dimmed={!!state.openThreadId}>
        <Board open={(id) => (state.openThreadId = id)} />
      </main>

      {#if state.openThreadId}
        <div class="scrim" onclick={() => (state.openThreadId = "")}></div>
        <aside class="drawer" aria-label="Thread">
          <ThreadView threadId={state.openThreadId} />
        </aside>
      {/if}
    </div>

    <Snackbar />
  </div>
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--m3-surface);
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: var(--m3-surface-container);
    border-bottom: 1px solid var(--m3-outline-variant);
    z-index: 5;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font: var(--m3-type-title-lg);
    font-weight: 600;
  }

  .brand-dot {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--m3-primary), var(--m3-tertiary));
  }

  .spacer {
    flex: 1;
  }

  .me {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 4px;
  }

  .me-name {
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface-variant);
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  main {
    flex: 1;
    min-width: 0;
    position: relative;
    transition: filter 0.2s ease;
  }

  main.dimmed {
    filter: brightness(0.96);
  }

  .scrim {
    position: fixed;
    inset: 0;
    background: var(--m3-scrim);
    opacity: 0.25;
    z-index: 20;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(620px, 96vw);
    background: var(--m3-surface-container-low);
    box-shadow: var(--m3-elev-4);
    border-left: 1px solid var(--m3-outline-variant);
    z-index: 25;
    animation: slideIn 0.22s cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes slideIn {
    from {
      transform: translateX(40px);
      opacity: 0.4;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @media (max-width: 640px) {
    .me-name {
      display: none;
    }
  }
</style>
