<script>
  import { onMount } from "svelte";
  import { appState, toast, resetSession, agentInitials } from "./lib/appState.svelte.js";
  import { avatarColor } from "./lib/utils.js";
  import * as api from "./lib/api.js";
  import Login from "./components/Login.svelte";
  import NavRail from "./components/NavRail.svelte";
  import ListView from "./components/ListView.svelte";
  import Board from "./components/Board.svelte";
  import Settings from "./components/Settings.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Snackbar from "./components/Snackbar.svelte";
  import PresenceRoster from "./components/PresenceRoster.svelte";
  import NotifBell from "./components/NotifBell.svelte";
  import CsatPage from "./components/CsatPage.svelte";

  let theme = $state("light");
  let booting = $state(true); // true until we know if a session exists
  let userMenuOpen = $state(false);

  // Public CSAT survey route: /csat/<token> renders a no-login page.
  let csatToken = $state("");
  function parseCsatPath() {
    const m = location.pathname.match(/\/csat\/([A-Za-z0-9_-]+)\/?$/);
    csatToken = m ? m[1] : "";
  }
  parseCsatPath();

  function applyTheme() {
    const saved = localStorage.getItem("gwmb.theme");
    theme = saved === "dark" ? "dark" : "light"; // light default
    document.documentElement.setAttribute("data-theme", theme);
  }
  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("gwmb.theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  // Request desktop notif permission after we know the user is signed in.
  onMount(async () => {
    applyTheme();
    parseCsatPath();
    if (csatToken) { booting = false; return; } // public survey page — no session
    const t = api.savedToken();
    if (!t) { booting = false; return; }
    appState.token = t;
    try {
      await api.loadSession();
      api.startRealtime();
      api.startPresenceLoop();
    } catch {
      logout();
      toast("error", "Session expired — sign in again");
    } finally {
      booting = false;
    }
  });

  async function handleLogin(email, password) {
    const res = await api.authWithPassword(email, password);
    appState.token = res.token;
    localStorage.setItem("gwmb.token", res.token);
    await api.loadSession();
    api.startRealtime();
    api.startPresenceLoop();
  }

  async function handleAdminLogin(email, password) {
    const res = await api.adminAuth(email, password);
    appState.token = res.token;
    localStorage.setItem("gwmb.token", res.token);
    await api.adminSession();
    appState.screen = "mail";
    api.startRealtime();
    api.startPresenceLoop();
  }

  function logout() {
    api.stopRealtime();
    api.stopPresenceLoop();
    resetSession();
    localStorage.removeItem("gwmb.token");
  }

  async function switchInbox(id) {
    appState.activeInboxId = id;
    appState.openThreadId = "";
    await api.refreshThreads();
  }
</script>

<svelte:head>
  <title>{appState.me ? "Mailbox" : "Sign in"} — shared inbox & kanban</title>
</svelte:head>

{#if booting}
  <div class="boot"><span class="brand-dot"></span><span>Loading…</span></div>
{:else if csatToken}
  <CsatPage token={csatToken} />
{:else if !appState.me}
  <Login signIn={handleLogin} signInAdmin={handleAdminLogin} />
{:else}
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span class="brand-name">Mailbox</span>
      </div>
      <div class="spacer"></div>
      <div class="md3-seg" role="tablist" aria-label="View">
        <button class:is-active={appState.view === "list"} onclick={() => (appState.view = "list")} title="List view">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
          List
        </button>
        <button class:is-active={appState.view === "board"} onclick={() => (appState.view = "board")} title="Board view">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v14H3z" opacity="0"/><path d="M3 5v14h8V5H3zm10 0v9h8V5h-8z"/></svg>
          Board
        </button>
      </div>
      <span class="md3-chip is-active">{appState.inboxes.find((i) => i.id === appState.activeInboxId)?.name || "—"}</span>
      <button class="md3-icon-btn" title="Settings" onclick={() => (appState.screen = appState.screen === "settings" ? "mail" : "settings")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
      </button>
      <button class="md3-icon-btn" title="Toggle theme" onclick={toggleTheme}>
        {#if theme === "dark"}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>
        {:else}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-12V3m0 18v-2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M3 12h2m14 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        {/if}
      </button>
      <PresenceRoster />
      <NotifBell />
      <div class="me">
        <button class="me-btn" onclick={() => (userMenuOpen = !userMenuOpen)} aria-haspopup="menu" aria-expanded={userMenuOpen} title="Account">
          <span class="avatar" style="background:{avatarColor(appState.me?.name || appState.me?.email)}">
            {agentInitials(appState.me?.name || appState.me?.email)}
          </span>
          <span class="me-name">{appState.me?.name || appState.me?.email}</span>
          <svg class="caret" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        {#if userMenuOpen}
          <div class="me-menu" role="menu">
            <div class="mm-ident">
              <strong>{appState.me?.name || "Account"}</strong>
              <span class="mm-email">{appState.me?.email}</span>
            </div>
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; appState.screen = "mail"; }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
              Inbox
            </button>
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; appState.screen = "settings"; }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
              Settings
            </button>
            <button class="mm-item danger" role="menuitem" onclick={logout}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
              Sign out
            </button>
          </div>
        {/if}
      </div>
    </header>

    <div class="body">
      <NavRail select={switchInbox} />
      <main class:dimmed={!!appState.openThreadId && appState.screen === "mail"}>
        {#if appState.screen === "settings"}
          <Settings />
        {:else if appState.view === "board"}
          <Board open={(id) => (appState.openThreadId = id)} />
        {:else}
          <ListView open={(id) => (appState.openThreadId = id)} />
        {/if}
      </main>

      {#if appState.openThreadId}
        <div class="scrim" onclick={() => (appState.openThreadId = "")}></div>
        <aside class="drawer" aria-label="Thread">
          <ThreadView threadId={appState.openThreadId} />
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
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    overscroll-behavior: none;
    background: var(--m3-surface);
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--m3-surface-container);
    border-bottom: 1px solid var(--m3-outline-variant);
    z-index: 5;
    flex-wrap: wrap;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font: var(--m3-type-title-lg);
    font-weight: 600;
  }

  .brand-dot {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--m3-primary);
  }

  .spacer {
    flex: 1;
  }

  .me {
    position: relative;
    display: flex;
    align-items: center;
  }

  .me-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 6px 3px 3px;
    border-radius: 999px;
    cursor: pointer;
  }

  .me-btn:hover {
    background: var(--m3-row-hover);
  }

  .me-btn .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .me-btn .caret {
    color: var(--m3-on-surface-variant);
  }

  .me-name {
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface-variant);
  }

  .me-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 80;
    min-width: 210px;
    background: var(--m3-surface-container-high);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    box-shadow: var(--m3-elev-4);
    padding: 6px;
  }

  .mm-ident {
    display: flex;
    flex-direction: column;
    padding: 6px 8px 8px;
    border-bottom: 1px solid var(--m3-outline-variant);
    margin-bottom: 4px;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
  }
  .mm-email {
    color: var(--m3-on-surface-variant);
    font-size: 0.8rem;
  }
  .mm-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 7px 8px;
    border-radius: 8px;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
  }
  .mm-item:hover {
    background: var(--m3-row-hover);
  }
  .mm-item.danger {
    color: var(--m3-error);
  }

  .boot {
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font: var(--m3-type-body-md);
    color: var(--m3-on-surface-variant);
    background: var(--m3-surface);
  }
  .boot .brand-dot {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
    transition: filter 0.2s ease;
  }

  main.dimmed {
    filter: brightness(0.96);
  }

  @media (max-width: 720px) {
    .body {
      flex-direction: column;
    }

    main {
      flex: 1 1 auto;
      order: 0;
      min-height: 0;
    }

    /* ---- mobile two-row topbar (no overflow) ---- */
    .topbar {
      gap: 4px 6px;
      padding: 5px 8px;
    }
    .brand {
      gap: 6px;
      margin-right: auto;
      min-width: 0;
    }
    .brand-name {
      font-size: 0.92rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brand-dot {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
    }
    .topbar .md3-seg {
      order: 10;
      flex-basis: 100%;
      justify-content: flex-start;
      margin-top: 2px;
    }
    .topbar .md3-seg button {
      font-size: 0.78rem;
      padding: 3px 10px;
    }
    .topbar .md3-chip.is-active {
      display: none; /* inbox name — too wide on mobile */
    }
    .topbar .md3-icon-btn {
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
    }
    .me {
      gap: 3px;
      margin-left: 0;
    }
    .me .avatar {
      width: 26px;
      height: 26px;
      font-size: 10px;
    }
    .me-menu {
      /* anchor to the LEFT edge of the avatar so it can't clip off-screen */
      right: auto;
      left: 0;
      min-width: 190px;
      max-width: 88vw;
    }
    .topbar .md3-icon-btn[title="Sign out"] {
      display: none; /* sign out via profile later; saves space */
    }
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
