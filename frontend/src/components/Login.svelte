<script>
  let { signIn } = $props();

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
      await signIn(email, password);
    } catch (e) {
      error = e?.message || "Sign-in failed";
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

    <label class="field">
      <span>Email</span>
      <input type="email" bind:value={email} placeholder="agent@yourdomain.com" autocomplete="email" />
    </label>
    <label class="field">
      <span>Password</span>
      <input type="password" bind:value={password} placeholder="••••••••" autocomplete="current-password" />
    </label>

    {#if error}<div class="err">{error}</div>{/if}

    <button class="md3-btn primary signin" type="submit" disabled={busy}>
      {busy ? "Signing in…" : "Sign in"}
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
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
  }

  .logo .dot {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--m3-primary);
    display: block;
  }

  h1 {
    font: var(--m3-type-headline);
    margin-top: 14px;
  }

  .tag {
    color: var(--m3-on-surface-variant);
    margin: 4px 0 20px;
    font: var(--m3-type-body-md);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-label-lg);
  }

  .field input {
    height: 48px;
    padding: 0 14px;
    border-radius: var(--m3-shape-xs);
    border: 1px solid var(--m3-outline);
    background: var(--m3-surface);
    outline: none;
    transition: border 0.15s ease;
  }

  .field input:focus {
    border: 2px solid var(--m3-primary);
  }

  .err {
    background: var(--m3-error-container);
    color: var(--m3-on-error-container);
    border-radius: var(--m3-shape-sm);
    padding: 10px 12px;
    font: var(--m3-type-body-sm);
    margin-bottom: 12px;
  }

  .signin {
    margin-top: 6px;
  }
</style>
