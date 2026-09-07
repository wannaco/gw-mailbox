<script>
  // My Profile — the signed-in user edits their own email signature + whether
  // it auto-appends to replies (Gmail-style). Admins can also edit signatures
  // from Settings → People.
  import { appState, toast } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";

  let signature = $state("");
  let signature_auto = $state(false);
  let busy = $state(false);
  let loaded = $state(false);

  function load() {
    const me = appState.me || {};
    signature = me.signature || "";
    signature_auto = !!me.signature_auto;
    loaded = true;
  }
  $effect(() => { if (!loaded) load(); });

  async function save() {
    busy = true;
    try {
      const r = await api.saveMySignature({ signature, signature_auto });
      signature = r.signature || "";
      signature_auto = !!r.signature_auto;
      appState.me = { ...appState.me, signature, signature_auto };
      // keep the directory copy fresh so Settings shows it too
      if (appState.users[appState.me?.id]) appState.users[appState.me.id].signature = signature;
      toast("success", "Signature saved");
    } catch (e) {
      toast("error", e?.message || "Could not save signature");
    } finally {
      busy = false;
    }
  }
</script>

<div class="profile">
  <h2>My profile</h2>
  <div class="card">
    <p class="ident">
      <strong>{appState.me?.name || appState.me?.email}</strong>
      <span class="muted">{appState.me?.email}</span>
    </p>

    <label class="field-row">
      <span>Email signature</span>
      <textarea rows="4" bind:value={signature}
        placeholder={"-- \n\nYour name\nRole · Company\nphone · website"}></textarea>
      <span class="hint">Multi-line text. Shown at the end of your replies to customers (like Gmail).</span>
    </label>

    <label class="switch-row">
      <span>
        <strong>Auto-insert signature on replies</strong>
        <span class="muted">Appends your signature to every customer reply you send. You can also insert it manually with the signature button in the composer.</span>
      </span>
      <input type="checkbox" bind:checked={signature_auto} />
    </label>

    <div class="row-btns" style="margin-top:14px">
      <button class="md3-btn primary" onclick={save} disabled={busy}>{busy ? "Saving…" : "Save signature"}</button>
    </div>
  </div>
</div>

<style>
  .profile { max-width: 640px; margin: 0 auto; padding: 24px 20px 60px; height: 100%; overflow-y: auto; box-sizing: border-box; }
  h2 { font: var(--m3-type-headline); margin: 0 0 16px; }
  .card { background: var(--m3-surface-container-low); border: 1px solid var(--m3-outline-variant); border-radius: var(--m3-shape-md); padding: 18px; }
  .ident { display: flex; flex-direction: column; gap: 2px; margin: 0 0 14px; }
  .muted { color: var(--m3-on-surface-variant); font: var(--m3-type-body-sm); }
  .hint { color: var(--m3-on-surface-variant-2); font: var(--m3-type-body-sm); margin-top: 4px; }
  .field-row { display: flex; flex-direction: column; gap: 6px; font: var(--m3-type-label-md); color: var(--m3-on-surface-variant); margin-bottom: 14px; }
  .field-row textarea { border: 1px solid var(--m3-outline-variant); border-radius: var(--m3-shape-sm); padding: 9px 11px; font: var(--m3-type-body-sm); background: var(--m3-surface-container-lowest); resize: vertical; min-height: 100px; }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .switch-row > span { display: flex; flex-direction: column; gap: 2px; }
  .row-btns { display: flex; gap: 10px; }
</style>
