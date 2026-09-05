<script>
  let { signIn, signInAdmin } = $props();

  let adminMode = $state(false);
  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit() {
    if (busy) return;
    error = "";
    if (!email || !password) {
      error = "Enter your email and password.";
      return;
    }
    busy = true;
    try {
      if (adminMode) await signInAdmin(email, password);
      else await signIn(email, password);
    } catch (e) {
      error = e?.message || (adminMode ? "Admin sign-in failed" : "Sign-in failed");
      busy = false;
    }
  }
</script>

<div class="login-wrap">
  <form class="login-card" onsubmit={(ev) => {
    ev.preventDefault();
    submit();
  }}>
    <div class="logo"><span class="dot"></span></div>
    <h1>Mailbox</h1>
    <p class="tag">Shared Google Workspace inbox &amp; kanban</p>

    <div class="md3-seg role-seg">
      <button type="button" class:is-active={!adminMode} onclick={() => (adminMode = false)}>Agent</button>
      <button type="button" class:is-active={adminMode} onclick={() => (adminMode = true)}>Admin</button>
    </div>
    <p class="subtag">{adminMode ? "PocketBase admin (Dashboard access + Settings)" : "Agent login"}</p>

    <label class="field">
      <span>Email</span>
      <input type="email" bind:value={email} placeholder={adminMode ? "admin@thinkcloud.dev" : "agent@yourdomain.com"} autocomplete="email" />
    </label>
    <label class="field">
      <span>Password</span>
      <input type="password" bind:value={password} placeholder="••••••••" autocomplete="current-password" />
    </label>

    {#if error}<div class="err">{error}</div>{/if}

    <button class="md3-btn primary signin" type="submit" disabled={busy}>
      {busy ? "Signing in…" : adminMode ? "Sign in as admin" : "Sign in"}
    </button>
  </form>
</div>

<style>
  .login-wrap {
    height: 100dvh;
    display: grid;
    place-items: center;
    background: var(--m3-surface);
    padding: 16px;
  }

  .login-card {
    width: min(380px, 100%);
    background: var(--m3-surface-container-low);
    border-radius: var(--m3-shape-lg);
    box-shadow: var(--m3-elev-2);
    padding: 28px;
    display: flex;
    flex-direction: column;
  }

  .logo .dot {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--m3-primary);
    display: block;
  }

  h1 {
    font: var(--m3-type-headline);
    margin-top: 12px;
  }

  .tag {
    color: var(--m3-on-surface-variant);
    margin: 2px 0 14px;
    font: var(--m3-type-body-sm);
  }

  .role-seg {
    align-self: flex-start;
    margin-bottom: 4px;
  }

  .subtag {
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant-2);
    margin-bottom: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 12px;
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-md);
  }

  .field input {
    height: 46px;
    padding: 0 13px;
    border-radius: var(--m3-shape-xs);
    border: 1px solid var(--m3-outline);
    background: var(--m3-surface);
    outline: none;
  }

  .field input:focus {
    border: 2px solid var(--m3-primary);
  }

  .err {
    background: var(--m3-error-container);
    color: var(--m3-on-error-container);
    border-radius: var(--m3-shape-sm);
    padding: 9px 12px;
    font: var(--m3-type-body-sm);
    margin-bottom: 10px;
  }

  .signin {
    margin-top: 4px;
  }
</style>
