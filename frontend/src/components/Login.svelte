<script>
  import { onMount } from "svelte";
  import * as api from "../lib/api.js";

  // NOTE: no admin tab. Admins are ordinary app users (users.role = admin)
  // who sign in through this same form (Google included). PocketBase's own
  // superuser is an infrastructure credential used only at /_/ and via CLI —
  // it must never be entered in the app, since that token is DB root.
  let { signIn, signInOAuth } = $props();

  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");
  let showPw = $state(false);

  // Google OAuth2 (only shown when PB users collection has it enabled+configured)
  let oauth = $state({ checking: true, available: false, busy: false });

  async function submit() {
    if (busy) return;
    error = "";
    if (!email || !password) {
      error = "Enter your email and password.";
      return;
    }
    busy = true;
    try {
      await signIn(email, password);
    } catch (e) {
      error = e?.message || "Sign-in failed";
      busy = false;
    }
  }

  async function detectOAuth() {
    try {
      const m = await api.checkOAuthProviders();
      oauth.available = !!(m.enabled && m.google && m.google.authUrl);
      oauth.google = m.google || null;
    } catch {
      oauth.available = false;
    } finally {
      oauth.checking = false;
    }
  }
  onMount(detectOAuth);

  // Google sign-in — full-page redirect (no popup, no popup-blocker issues and
  // it works on mobile). PocketBase builds the provider authURL with a BLANK
  // `redirect_uri=` and expects the CLIENT to append the encoded redirect URL.
  // We point it at OUR OWN callback route — NOT PB's /api/oauth2-redirect,
  // which 307s into the PocketBase admin dashboard (its own admin login flow)
  // so the SPA never received the code. The PKCE verifier is stashed in
  // sessionStorage and the exchange finishes in App.svelte at /auth/callback.
  function googleSignIn() {
    if (!oauth.available || oauth.busy) return;
    error = "";
    oauth.busy = true;
    const redirectURL = window.location.origin + "/auth/callback";
    try {
      sessionStorage.setItem("gwmb.oauth", JSON.stringify({
        verifier: oauth.google.codeVerifier || "",
        state: oauth.google.state || "",
        redirectURL: redirectURL
      }));
    } catch (_) { /* private mode — exchange will report an error */ }
    window.location.href = oauth.google.authUrl + encodeURIComponent(redirectURL);
  }

</script>

<div class="login-wrap">
  <!-- Decoration lives in its own clipped layer. Putting `overflow: hidden` on
       .login-wrap directly would clip the FORM on a short viewport, leaving no
       way to scroll to the button. -->
  <div class="deco" aria-hidden="true">
    <span class="p1"></span>
    <span class="p2"></span>
  </div>

  <div class="login-shell">
    <section class="brand-panel" aria-hidden="true">
      <div class="brand-inner">
        <div class="logo">
          <span class="mark">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z"/>
            </svg>
          </span>
          <span class="wordmark">Mailbox</span>
        </div>
        <p>One shared inbox for your whole team — tickets, replies, SLAs and CSAT in one place.</p>
        <ul class="features">
          <li><span>✓</span> Shared Gmail queue &amp; kanban</li>
          <li><span>✓</span> Realtime presence &amp; mentions</li>
          <li><span>✓</span> Follow-ups, SLA &amp; surveys</li>
        </ul>
      </div>
    </section>

    <form class="login-card" onsubmit={(ev) => { ev.preventDefault(); submit(); }}>
      <div class="card-logo">
        <span class="mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z"/>
          </svg>
        </span>
        <span class="wordmark">Mailbox</span>
      </div>

      <h1>Welcome back</h1>
      <p class="tag">Sign in to your team workspace</p>

      {#if oauth.available}
        <button type="button" class="google-btn" onclick={googleSignIn} disabled={oauth.busy}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.1 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/>
          </svg>
          {oauth.busy ? "Connecting to Google…" : "Continue with Google"}
        </button>
        <div class="or-divider"><span>or</span></div>
      {/if}

      {#if oauth.checking}
        <div class="subtag muted">Checking sign-in options…</div>
      {/if}

      <label class="field">
        <span class="lbl">Email</span>
        <div class="input-wrap">
          <input type="email" bind:value={email} placeholder="you@yourdomain.com" autocomplete="email" />
          <span class="fld-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/>
              <path d="M3 7l9 6 9-6"/>
            </svg>
          </span>
        </div>
      </label>

      <label class="field">
        <span class="lbl">Password</span>
        <div class="input-wrap">
          <input type={showPw ? "text" : "password"} bind:value={password} placeholder="••••••••" autocomplete="current-password" />
          <button type="button" class="pw-toggle" onclick={() => (showPw = !showPw)} tabindex="-1" aria-label={showPw ? "Hide password" : "Show password"}>
            {#if showPw}
              <!-- eye-off: password is visible, click to hide -->
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            {:else}
              <!-- eye: password is hidden, click to show -->
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            {/if}
          </button>
        </div>
      </label>

      {#if error}<div class="err">{error}</div>{/if}

      <button class="md3-btn primary signin" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </div>
</div>

<style>
  .login-wrap {
    position: relative;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--m3-surface);
  }

  /* Angled planes behind the card — the structural idea from the reference:
     the panel does not sit flat on the page, it sits on rotated layers that
     extend past it. Two different rotations and opacities so they read as
     stacked depth rather than one flat shape. */
  .deco {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .deco span {
    position: absolute;
    display: block;
    border-radius: 52px;
    background: linear-gradient(140deg, var(--m3-primary), #0b57d0);
  }
  .p1 {
    width: min(540px, 58vw);
    height: min(540px, 58vw);
    top: -15%;
    left: -7%;
    transform: rotate(34deg);
    opacity: 0.14;
  }
  .p2 {
    width: min(430px, 47vw);
    height: min(430px, 47vw);
    bottom: -17%;
    right: -5%;
    transform: rotate(21deg);
    opacity: 0.1;
  }

  /* Above the decoration layer. */
  .login-shell {
    position: relative;
    z-index: 1;
  }

  .login-shell {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(340px, 0.9fr);
    width: min(920px, 100%);
    max-height: min(620px, calc(100dvh - 32px));
    border-radius: 24px;
    overflow: hidden;
    /* Same colour as the card: the brand panel's slanted edge is clipped, and
       this is what shows through the wedge it leaves behind. */
    background: var(--m3-surface-container-low);
    box-shadow: 0 32px 64px -28px rgb(11 87 208 / 0.42), 0 6px 20px -10px rgb(0 0 0 / 0.18);
    border: 1px solid var(--m3-outline-variant);
  }

  /* Left brand panel */
  .brand-panel {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 52px 40px 40px;
    background: linear-gradient(150deg, #0b57d0 0%, #1a73e8 45%, #3949ab 100%);
    color: #fff;
    overflow: hidden;
    /* Slanted right edge. 9% over a ~600px panel is a shallow lean, which is
       deliberate - a steeper angle would eat the text column and read as a
       gimmick. The angled bands below carry the rest of the geometry. */
    clip-path: polygon(0 0, 100% 0, 91% 100%, 0 100%);
  }

  /* Rotated bands in place of the old blurred circles. Circles read as soft
     decoration; bands read as planes at an angle, which is the point. */
  .brand-panel::before,
  .brand-panel::after {
    content: "";
    position: absolute;
    pointer-events: none;
    transform: rotate(-17deg);
  }
  .brand-panel::before {
    width: 200%;
    height: 230px;
    top: 1%;
    left: -50%;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.17), rgba(255, 255, 255, 0.015));
  }
  .brand-panel::after {
    width: 200%;
    height: 190px;
    bottom: 3%;
    left: -60%;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.15));
  }

  .brand-inner { position: relative; z-index: 1; max-width: 380px; }
  .brand-inner p { opacity: 0.92; font-size: 0.98rem; line-height: 1.45; }

  /* Logo mark: an inbox glyph, not a letter. It previously rendered as a bare
     "M" because `.dot` had no styles on desktop at all (only `.mobile-logo
     .dot` was defined) — so the only visible part of the logo was the letter. */
  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }
  .wordmark {
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .features { list-style: none; margin: 24px 0 0; padding: 0; display: grid; gap: 10px; }
  .features li { display: flex; align-items: center; gap: 9px; font-size: 0.9rem; opacity: 0.95; }
  .features span {
    width: 20px; height: 20px; border-radius: 50%; background: rgba(255,255,255,0.22);
    display: inline-flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800;
  }

  /* Right card */
  .login-card {
    display: flex;
    flex-direction: column;
    padding: 30px 34px 30px;
    background: var(--m3-surface-container-low);
    overflow-y: auto;
  }

  /* Compact mark for the card, where the brand panel is hidden (mobile). */
  .card-logo { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; }
  .card-logo .mark {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    background: var(--m3-primary-container);
    color: var(--m3-on-primary-container);
  }
  .card-logo .wordmark { font-size: 1.05rem; color: var(--m3-on-surface); }

  h1 { font: var(--m3-type-headline); margin: 0 0 4px; }
  .tag { color: var(--m3-on-surface-variant); margin: 0 0 18px; font: var(--m3-type-body-md); }
  .subtag { font: var(--m3-type-label-sm); color: var(--m3-on-surface-variant-2); margin-bottom: 16px; }
  .subtag.muted { color: var(--m3-on-surface-variant-2); }

  .google-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px 14px;
    margin-bottom: 4px;
    border-radius: 999px;
    border: 1px solid var(--m3-outline);
    background: var(--m3-surface);
    color: var(--m3-on-surface);
    font: var(--m3-type-body-md);
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .google-btn:hover:not(:disabled) { background: var(--m3-surface-container-highest); }
  .google-btn:disabled { opacity: 0.6; cursor: default; }

  .or-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-sm);
    margin: 10px 0 14px;
  }
  .or-divider::before, .or-divider::after { content: ""; flex: 1; height: 1px; background: var(--m3-outline-variant); }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 13px;
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-md);
  }
  .lbl { font-weight: 600; }
  .input-wrap { position: relative; display: flex; align-items: center; }

  .field input {
    width: 100%;
    height: 46px;
    padding: 0 44px 0 13px; /* room for the trailing icon */
    border-radius: var(--m3-shape-xs);
    border: 1px solid var(--m3-outline);
    background: var(--m3-surface);
    color: var(--m3-on-surface);
    outline: none;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .field input:focus { border: 2px solid var(--m3-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--m3-primary) 18%, transparent); }

  /* Trailing field icon — the envelope. Purely decorative, hence aria-hidden
     and pointer-events:none so it never swallows a click into the input. */
  .fld-icon {
    position: absolute;
    right: 13px;
    display: grid;
    place-items: center;
    color: var(--m3-on-surface-variant-2);
    pointer-events: none;
  }

  .pw-toggle {
    position: absolute; right: 6px;
    display: grid; place-items: center;
    width: 34px; height: 34px;
    background: none; border: 0; cursor: pointer;
    color: var(--m3-on-surface-variant-2);
    border-radius: 50%;
  }
  .pw-toggle:hover { background: var(--m3-surface-container-highest); color: var(--m3-on-surface); }

  .err {
    background: var(--m3-error-container);
    color: var(--m3-on-error-container);
    border-radius: var(--m3-shape-sm);
    padding: 9px 12px;
    font: var(--m3-type-body-sm);
    margin-bottom: 10px;
  }

  /* Pill CTA, as in the reference. Overrides the 8px .md3-btn radius. */
  .signin {
    margin-top: 6px;
    height: 48px;
    border-radius: 999px;
    font-weight: 600;
  }

  @media (max-width: 760px) {
    .login-shell { grid-template-columns: 1fr; max-height: none; }
    .brand-panel { display: none; }
  }
</style>
