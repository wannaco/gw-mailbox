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
  import Reports from "./components/Reports.svelte";
  import Profile from "./components/Profile.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Snackbar from "./components/Snackbar.svelte";
  import PresenceRoster from "./components/PresenceRoster.svelte";
  import NotifBell from "./components/NotifBell.svelte";
  import CsatPage from "./components/CsatPage.svelte";
  import NoticesPage from "./components/NoticesPage.svelte";
  import { parsePath, buildPath, isPublicPath } from "./lib/router.js";

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

  // Public third-party notices route: /notices renders a no-login page.
  let noticesPage = $state(location.pathname.replace(/\/+$/, "").endsWith("/notices"));

  // ---- URL routing ---------------------------------------------------------
  // The app's default inbox is "/", not "/inbox/<id>", so a plain visit does not
  // bake an id into the address bar. Captured once and kept for buildPath().
  let defaultInboxId = null;

  // The path the user actually arrived on, captured ONCE at init.
  //
  // Must be captured here, not read later: loadSession() assigns activeInboxId,
  // which makes routingActive() true and lets the sync effect write the URL —
  // overwriting the arrival path with the bare inbox BEFORE anything has read it.
  // Reading location.pathname inside adoptArrivalUrl() therefore saw the already
  // truncated "/inbox/<id>" and dropped the thread from cold deep links.
  const arrivalPath = location.pathname;

  // URL writes stay off until the arrival path has been applied, so nothing can
  // clobber the user's link during boot.
  let routeReady = false;

  // Suppresses the write-back while we are applying a URL (boot, back/forward),
  // so the sync effect cannot bounce the path against itself.
  let applyingUrl = false;

  // True when the current view is something we own and reflect in the URL. Public
  // pages (csat/notices/auth-callback) and the logged-out screen are excluded.
  function routingActive() {
    return routeReady && !csatToken && !noticesPage && !booting;
  }

  // `push=true` records a history entry so the browser Back button returns here;
  // `push=false` corrects the URL in place.
  //
  // PUSH for navigation the user performed deliberately — switching section,
  // changing mailbox, opening or closing a thread — because Back should undo
  // those. REPLACE for the default inbox id being resolved after boot: that is
  // bookkeeping, and pushing it would mean Back lands on a URL that immediately
  // redirects forward again, which is the classic history trap.
  function syncUrl(push) {
    if (!routingActive() || applyingUrl) return;
    const next = buildPath(
      {
        screen: appState.screen,
        view: appState.view,
        activeInboxId: appState.activeInboxId,
        openThreadId: appState.openThreadId
      },
      defaultInboxId
    );
    const cur = location.pathname.replace(/\/+$/, "") || "/";
    if (cur === next) return;
    if (push) history.pushState(null, "", next);
    else history.replaceState(null, "", next);
  }

  // Apply a pathname to the view state. Returns false if the inbox in the URL is
  // not one this user may see, in which case we fall back to the default list
  // rather than leaving them on an empty screen.
  function applyPath(pathname) {
    const next = parsePath(pathname);
    applyingUrl = true;
    try {
      appState.screen = next.screen;
      appState.view = next.view;
      if (next.activeInboxId) {
        const known = (appState.inboxes || []).some((i) => i.id === next.activeInboxId);
        if (!known) {
          appState.activeInboxId = defaultInboxId || appState.activeInboxId;
          appState.openThreadId = "";
          history.replaceState(null, "", buildPath({
            screen: appState.screen, view: appState.view,
            activeInboxId: appState.activeInboxId, openThreadId: ""
          }, defaultInboxId));
          return false;
        }
        if (next.activeInboxId !== appState.activeInboxId) {
          appState.activeInboxId = next.activeInboxId;
          appState.threadsPagesInbox = ""; // force a page-1 reload for this mailbox
          api.refreshThreads().catch(() => {});
        }
      }
      appState.openThreadId = next.openThreadId;
    } finally {
      applyingUrl = false;
    }
    return true;
  }

  // Mirror appState into the URL whenever the parts a URL encodes change.
  $effect(() => {
    appState.screen;
    appState.view;
    appState.activeInboxId;
    appState.openThreadId;
    appState.me;
    syncUrl(true);
  });

  function onPopState() {
    if (!routingActive()) return;
    applyPath(location.pathname);
  }

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
    if (location.pathname.replace(/\/+$/, "") === "/auth/callback") {
      try {
        await handleOAuthCallback();
        toast("success", "Signed in with Google");
      } catch (e) {
        toast("error", e?.message || "Google sign-in failed");
      }
      // The OAuth flow lands on /auth/callback, which is not a view path — it has
      // already been rewritten to "/" by handleOAuthCallback. So there is no
      // arrival URL to adopt here; just start mirroring state so later navigation
      // updates the URL. (A deep link cannot survive this flow, since the
      // provider redirects to the fixed callback path.)
      defaultInboxId = appState.inboxes[0]?.id || null;
      routeReady = true;
      syncUrl(false);
      booting = false;
      return;
    }
    parseCsatPath();
    if (csatToken) { booting = false; return; } // public survey page — no session
    if (noticesPage) { booting = false; return; } // public notices page — no session
    window.addEventListener("popstate", onPopState);
    const t = api.savedToken();
    if (!t) { booting = false; return; }
    appState.token = t;
    try {
      await api.loadSession();
      api.startRealtime();
      api.startPresenceLoop();
      // Now that inboxes are known, adopt the URL. Any signed-in path resolves
      // here, so a refresh or a pasted link lands where it should.
      adoptArrivalUrl();
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
    adoptArrivalUrl();
  }

  // Google OAuth callback landing (/auth/callback?code=...&state=...).
  // Completes the PKCE exchange with the verifier the login screen stashed in
  // sessionStorage, then bootstraps the session exactly like a password login.
  async function handleOAuthCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code") || "";
    const state = q.get("state") || "";
    const errParam = q.get("error") || "";
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem("gwmb.oauth") || "{}") || {}; } catch (_) {}
    try { sessionStorage.removeItem("gwmb.oauth"); } catch (_) {}
    history.replaceState(null, "", "/"); // never replay the code on refresh
    if (errParam) throw new Error(q.get("error_description") || errParam);
    if (!code) throw new Error("Google sign-in returned no code");
    if (!saved.verifier) throw new Error("Sign-in session expired — please try again");
    if (saved.state && state && saved.state !== state) throw new Error("Sign-in state mismatch — please try again");
    const redirectURL = saved.redirectURL || window.location.origin + "/auth/callback";
    const res = await api.oauthExchange("google", code, saved.verifier, redirectURL);
    if (!res || !res.token) throw new Error("Google sign-in returned no session");
    appState.token = res.token;
    localStorage.setItem("gwmb.token", res.token);
    await api.loadSession();
    api.startRealtime();
    api.startPresenceLoop();
  }

  // Google OAuth2 success — same bootstrap as an agent password login.
  async function handleOAuth(token) {
    appState.token = token;
    localStorage.setItem("gwmb.token", token);
    await api.loadSession();
    api.startRealtime();
    api.startPresenceLoop();
    adoptArrivalUrl();
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

  // Section navigation. The $effect above is what writes the URL; these just set
  // state, so there is a single code path that touches history.
  function goScreen(screen) {
    appState.screen = screen;
  }

  // Adopt whatever URL the user arrived on, once a session exists.
  //
  // Needed after login specifically: a cold deep link ("<domain>/inbox/x/thread/y")
  // is loaded while signed out, when the inbox list is still empty, so parsing it
  // there can only set the screen — the thread id would be dropped. Re-applying
  // now that inboxes are known is what makes the link land on the ticket the
  // sender intended rather than the bare mailbox.
  function adoptArrivalUrl() {
    defaultInboxId = appState.inboxes[0]?.id || null;
    const arrivedOn = arrivalPath.replace(/\/+$/, "") || "/";
    applyPath(arrivedOn);
    // Landing on "/" resolves an inbox id that should NOT be written back to the
    // URL — replace only, so Back never bounces forward again.
    if (arrivedOn === "/") {
      const canonical = buildPath(
        { screen: appState.screen, view: appState.view, activeInboxId: "", openThreadId: "" },
        defaultInboxId
      );
      history.replaceState(null, "", canonical === "/" ? "/" : canonical);
    }
    // From here on the URL mirrors state normally.
    routeReady = true;
    syncUrl(false);
  }
</script>

<svelte:head>
  <title>{appState.me ? "Mailbox" : "Sign in"} — shared inbox & kanban</title>
</svelte:head>

{#if booting}
  <div class="boot"><span class="brand-dot"></span><span>Loading…</span></div>
{:else if csatToken}
  <CsatPage token={csatToken} />
{:else if noticesPage}
  <NoticesPage />
{:else if !appState.me}
  <Login signIn={handleLogin} signInOAuth={handleOAuth} />
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
      <button class="md3-icon-btn" title="Settings" onclick={() => goScreen(appState.screen === "settings" ? "mail" : "settings")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
      </button>
      <button class="md3-icon-btn" title="Toggle theme" onclick={toggleTheme}>
        {#if theme === "dark"}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>
        {:else}
          <!-- Stroke, not fill: these paths are bare line segments (M12 17a5 5…
               and the rays). With fill="currentColor" and no stroke they had no
               area to paint, so the light-theme toggle rendered as a black dot
               where the sun's rays should have been. -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2m0 14.4v2.2M4.4 4.4l1.6 1.6m12 12 1.6 1.6M2.6 12h2.2m14.4 0h2.2M4.4 19.6l1.6-1.6m12-12 1.6-1.6"/></svg>
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
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; goScreen("mail"); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
              Inbox
            </button>
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; goScreen("settings"); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
              Settings
            </button>
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; goScreen("profile"); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
              My profile
            </button>
            <button class="mm-item" role="menuitem" onclick={() => { userMenuOpen = false; goScreen("reports"); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 9h3v9H5zm5.5-5h3v14h-3zm5.5 8h3v6h-3z"/></svg>
              Reports
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
        {:else if appState.screen === "reports"}
          <Reports />
        {:else if appState.screen === "profile"}
          <Profile />
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
    /* Above page content: the toolbar inside <main> sets z-index 20 (for its
       Columns menu), and the account/roster dropdowns live in THIS stacking
       context — so the topbar must outrank the toolbar or the page paints
       over the menus (dropdowns appeared under the search box on mobile). */
    position: relative;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 16px;
    /* Not surface-container-lowest: in dark that tone is DARKER than the page,
       so the topbar read as a recess rather than a raised bar. */
    background: var(--m3-surface-raised);
    /* Shadow instead of a hairline: the topbar is a surface sitting above the
       content, and a tinted shadow says that more cleanly than a grey rule. */
    box-shadow: var(--m3-elev-layer);
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
    width: 22px;
    height: 22px;
    border-radius: 7px;
    background: var(--m3-primary);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.18);
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
    /* Anchors the scrim + drawer to the area BELOW the topbar. They used to be
       position:fixed with top:0, which put them under the (opaque, z-index 30)
       topbar — the drawer's own header, including the contact button, was
       painted over and unreachable. */
    position: relative;
  }

  main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
    transition: filter 0.2s ease;
    /* Own stacking context. Page-level popovers (list quick-actions z 90,
       Columns menu z 60) otherwise compete with the drawer at the same level
       and can paint on top of it. Contained at 0, it stays under the scrim. */
    z-index: 0;
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
    position: absolute;
    inset: 0;
    /* One dimming token for the whole app — see --m3-scrim-soft in m3.css. */
    background: var(--m3-scrim-soft);
    z-index: 20;
  }

  .drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(620px, 96vw);
    background: var(--m3-surface-container-low);
    box-shadow: var(--m3-elev-4);
    border-left: 1px solid var(--m3-outline-variant);
    /* Above the topbar (30) so the drawer's own full-screen overlays — the
       contact panel (z 95, inside this stacking context) — can cover the whole
       viewport instead of being clipped at the topbar. */
    z-index: 35;
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
