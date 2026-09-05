<script>
  import { onMount } from "svelte";
  import { appState, toast } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";

  let loaded = $state(false);
  let isAdmin = $state(false);
  let saEmail = $state("");
  let saJson = $state("");
  let pollSync = $state(false);
  let busySave = $state(false);
  let busyTest = $state(false);
  let busyPoll = $state(false);
  let testResult = $state(""); // "" | ok:<email> | err:<msg>
  let testSubject = $state("team@thinkcloud.dev");
  let fileInput;

  // mailbox add
  let newName = $state("");
  let newEmail = $state("");
  let busyAdd = $state(false);
  let busyWatch = $state(""); // inbox id being watched

  async function refresh() {
    try {
      const s = await api.getSettings();
      isAdmin = true;
      saEmail = s.serviceAccountEmail || "";
      pollSync = !!s.pollSync;
    } catch (e) {
      isAdmin = false;
      if (e?.status !== 401 && e?.status !== 403) toast("error", e?.message || "Failed to load settings");
    } finally {
      loaded = true;
    }
  }

  onMount(refresh);

  async function saveKey() {
    if (!saJson.trim()) return;
    busySave = true;
    try {
      const r = await api.saveServiceAccount(saJson);
      saEmail = r.serviceAccountEmail || saEmail;
      saJson = "";
      toast("success", "Service account saved");
      await refresh();
    } catch (e) {
      toast("error", e?.message || "Invalid key");
    } finally {
      busySave = false;
    }
  }

  async function removeKey() {
    if (!confirm("Remove the stored service account key?")) return;
    try {
      await api.removeServiceAccount();
      saEmail = "";
      toast("success", "Key removed");
      await refresh();
    } catch (e) {
      toast("error", e?.message || "Could not remove");
    }
  }

  async function runTest() {
    busyTest = true;
    testResult = "";
    try {
      const r = await api.testConnection(testSubject.trim(), saJson.trim() || undefined);
      testResult = "ok:" + (r.emailAddress || "") + " · history " + (r.historyId || "-") + " · msgs " + (r.messagesTotal ?? "-");
    } catch (e) {
      testResult = "err:" + (e?.message || String(e));
    } finally {
      busyTest = false;
    }
  }

  async function togglePoll(ev) {
    busyPoll = true;
    try {
      const r = await api.setPollSync(ev.target.checked);
      pollSync = !!r.pollSync;
      toast("success", pollSync ? "Poll sync enabled (every minute)" : "Poll sync disabled");
    } catch (e) {
      toast("error", e?.message || "Failed to update sync mode");
    } finally {
      busyPoll = false;
    }
  }

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        JSON.parse(reader.result); // validate
        saJson = reader.result;
        toast("success", "Key file loaded — press Save");
      } catch (_) {
        toast("error", "That file is not valid JSON (service-account key file)");
      }
    };
    reader.readAsText(file);
  }

  async function addInbox() {
    if (!newName.trim() || !newEmail.trim()) return;
    busyAdd = true;
    try {
      await api.pbRequest("POST", "/collections/inboxes/records", {
        name: newName.trim(),
        email_address: newEmail.trim().toLowerCase(),
        allowed_users: [],
        allowed_teams: [],
        is_active: true
      });
      toast("success", "Inbox created");
      newName = "";
      newEmail = "";
      await api.loadSession(); // superuser /me returns all inboxes
    } catch (e) {
      toast("error", e?.message || "Could not create inbox");
    } finally {
      busyAdd = false;
    }
  }

  async function startWatch(inboxId) {
    busyWatch = inboxId;
    try {
      const r = await api.pbRequest("POST", `/mailbox/inboxes/${inboxId}/watch`);
      toast("success", "Watch started · historyId " + (r.historyId || "-"));
    } catch (e) {
      toast("error", (e?.message || "Watch failed") + " — enable Poll sync (below) as the fallback");
    } finally {
      busyWatch = "";
    }
  }
</script>

<div class="settings">
  <h2>Settings</h2>
  {#if !loaded}
    <p class="muted">Loading…</p>
  {:else if !isAdmin}
    <div class="card">
      <p><strong>Admin only.</strong></p>
      <p class="muted">Sign out and sign back in with the PocketBase admin account (or use the admin sign-in on the login screen) to manage the Google connection.</p>
    </div>
  {:else}
    <!-- Google connection -->
    <section class="card">
      <h3>Google Workspace connection</h3>
      {#if saEmail}
        <p class="ok">Connected as <strong>{saEmail}</strong></p>
        <button class="md3-btn outlined" onclick={removeKey}>Remove key</button>
      {:else}
        <p class="muted">No service-account key stored yet. Paste the JSON below (or upload the .json file).</p>
      {/if}
      <textarea class="sa-input" rows="6" bind:value={saJson} placeholder="Paste the full service-account JSON here"></textarea>
      <div class="row-btns">
        <button class="md3-btn primary" onclick={saveKey} disabled={busySave || !saJson.trim()}>
          {busySave ? "Saving…" : saEmail ? "Replace key" : "Save key"}
        </button>
        <label class="md3-btn tonal file-btn">
          Upload .json file
          <input type="file" accept=".json,application/json" hidden onchange={onFile} bind:this={fileInput} />
        </label>
      </div>
    </section>

    <!-- Connection test -->
    <section class="card">
      <h3>Test connection</h3>
      <label class="field-row">
        <span>Mailbox to impersonate</span>
        <input type="email" bind:value={testSubject} placeholder="team@thinkcloud.dev" />
      </label>
      <button class="md3-btn tonal" onclick={runTest} disabled={busyTest || !saEmail}>
        {busyTest ? "Testing…" : "Test with this mailbox"}
      </button>
      {#if testResult}
        <p class:ok={testResult.startsWith("ok")} class:err={testResult.startsWith("err")}>
          {testResult.startsWith("ok:") ? "✅ " + testResult.slice(3) : "❌ " + testResult.slice(4)}
        </p>
      {/if}
    </section>

    <!-- Sync mode -->
    <section class="card">
      <h3>Sync</h3>
      <label class="switch-row">
        <span>
          <strong>Poll every minute</strong>
          <span class="muted">Works with just the key — no Pub/Sub. New mail appears ~1 min after arrival.</span>
        </span>
        <input type="checkbox" checked={pollSync} onchange={togglePoll} disabled={busyPoll} />
      </label>
    </section>

    <!-- Mailboxes -->
    <section class="card">
      <h3>Mailboxes</h3>
      <ul class="inbox-list">
        {#each appState.inboxes as inbox (inbox.id)}
          <li>
            <span class="inbox-name">{inbox.name}</span>
            <span class="muted">{inbox.email_address}</span>
            {#if inbox.history_id}
              <span class="pill" title="Gmail sync cursor">history {inbox.history_id.slice(0, 8)}…</span>
            {/if}
            <button class="md3-btn tonal small" onclick={() => startWatch(inbox.id)} disabled={busyWatch === inbox.id}>
              {busyWatch === inbox.id ? "Watching…" : "Watch"}
            </button>
          </li>
        {/each}
      </ul>
      <div class="add-inbox">
        <input type="text" bind:value={newName} placeholder="Name (Support…)" />
        <input type="email" bind:value={newEmail} placeholder="mailbox@thinkcloud.dev" />
        <button class="md3-btn primary small" onclick={addInbox} disabled={busyAdd}>Add mailbox</button>
      </div>
      <p class="hint">Tip: “Watch” needs a Pub/Sub topic configured in env (GOOGLE_PUBSUB_TOPIC). If you don't use Pub/Sub, enable Poll instead.</p>
    </section>
  {/if}
</div>

<style>
  .settings {
    max-width: 680px;
    margin: 0 auto;
    padding: 24px 20px 60px;
  }

  h2 {
    font: var(--m3-type-headline);
    margin-bottom: 16px;
  }

  .card {
    background: var(--m3-surface-container-low);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    padding: 16px;
    margin-bottom: 16px;
  }

  h3 {
    font: var(--m3-type-title-md);
    margin-bottom: 10px;
  }

  .muted {
    color: var(--m3-on-surface-variant);
    font: var(--m3-type-body-sm);
  }

  .ok {
    color: #188038;
    font-weight: 600;
  }

  .err {
    color: var(--m3-error);
    font-weight: 600;
  }

  .sa-input {
    width: 100%;
    margin: 10px 0;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 10px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.78rem;
    resize: vertical;
    background: var(--m3-surface-container-lowest);
  }

  .row-btns {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .file-btn input {
    display: none;
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 0;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
  }

  .field-row input,
  .add-inbox input {
    height: 40px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-sm);
    padding: 0 12px;
    background: var(--m3-surface-container-lowest);
    max-width: 360px;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .switch-row > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .inbox-list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
  }

  .inbox-list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--m3-outline-variant);
  }

  .inbox-name {
    font-weight: 600;
    min-width: 90px;
  }

  .pill {
    font: var(--m3-type-label-sm);
    background: var(--m3-surface-container-high);
    border-radius: 999px;
    padding: 2px 10px;
    color: var(--m3-on-surface-variant);
  }

  .add-inbox {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .hint {
    margin-top: 8px;
    color: var(--m3-on-surface-variant-2);
    font: var(--m3-type-body-sm);
  }
</style>
