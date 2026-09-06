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
  let mailboxes = $state([]); // admin list from settings API
  let newUserIds = $state([]); // agents to grant access to the new mailbox
  let savingMb = $state(""); // id being toggled/deleted

  // labels
  let labels = $state([]);
  let newLabel = $state("");
  let newLabelColor = $state("#0b57d0");

  const agentOptions = $derived(Object.values(appState.users));

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
    if (isAdmin) {
      try {
        const mb = await api.listMailboxes();
        mailboxes = mb.inboxes || [];
      } catch (_) {}
      try {
        const lb = await api.listLabels();
        labels = (lb.items || []).map((l) => ({ id: l.id, name: l.name, color: l.color || "" }));
      } catch (_) {}
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
      const r = await api.createMailbox({
        name: newName.trim(),
        email_address: newEmail.trim().toLowerCase(),
        allowed_user_ids: newUserIds,
        is_active: true
      });
      toast("success", "Mailbox created — grant the sync scopes in Google DWD for " + r.inbox.email_address);
      newName = "";
      newEmail = "";
      newUserIds = [];
      await refresh();
      await api.loadSession();
    } catch (e) {
      toast("error", e?.message || "Could not create mailbox");
    } finally {
      busyAdd = false;
    }
  }

  async function toggleInbox(id) {
    savingMb = id;
    const mb = mailboxes.find((m) => m.id === id);
    try {
      await api.updateMailbox(id, { is_active: !mb.is_active });
      await refresh();
    } catch (e) {
      toast("error", e?.message || "Update failed");
    } finally {
      savingMb = "";
    }
  }

  async function removeInbox(id) {
    if (!confirm("Delete this mailbox and its threads?")) return;
    savingMb = id;
    try {
      await api.deleteMailbox(id);
      await refresh();
      await api.loadSession();
    } catch (e) {
      toast("error", e?.message || "Delete failed");
    } finally {
      savingMb = "";
    }
  }

  function toggleNewAgent(id) {
    newUserIds = newUserIds.includes(id) ? newUserIds.filter((x) => x !== id) : [...newUserIds, id];
  }

  async function saveMbAgents(mb) {
    const ids = mb.allowed_users.map((u) => u.id);
    try {
      await api.updateMailbox(mb.id, { allowed_user_ids: ids });
      toast("success", "Access updated");
    } catch (e) {
      toast("error", e?.message || "Update failed");
    }
  }

  async function addLabel() {
    if (!newLabel.trim()) return;
    try {
      await api.createLabelRecord({ name: newLabel.trim(), color: newLabelColor });
      newLabel = "";
      const lb = await api.listLabels();
      labels = (lb.items || []).map((l) => ({ id: l.id, name: l.name, color: l.color || "" }));
    } catch (e) {
      toast("error", e?.message || "Could not add label");
    }
  }

  async function removeLabel(id) {
    if (!confirm("Delete this label?")) return;
    try {
      await api.deleteLabelRecord(id);
      const lb = await api.listLabels();
      labels = (lb.items || []).map((l) => ({ id: l.id, name: l.name, color: l.color || "" }));
    } catch (e) {
      toast("error", e?.message || "Delete failed");
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
      <p class="muted">Add the Google Workspace mailboxes you want this team to use. After adding, grant the service account’s domain-wide delegation for each (see Google Admin → API controls). New mail syncs when Poll or Watch is on.</p>

      <ul class="inbox-list">
        {#each mailboxes as mb (mb.id)}
          <li>
            <div class="mb-main">
              <div class="mb-title">
                <span class="inbox-name">{mb.name}</span>
                <span class="muted">{mb.email_address}</span>
                <span class="pill" class:off={!mb.is_active}>{mb.is_active ? "active" : "paused"}</span>
              </div>
              <div class="mb-agents">
                <span class="muted small">Agents:</span>
                {#each agentOptions as u (u.id)}
                  <label class="ag-check">
                    <input
                      type="checkbox"
                      checked={mb.allowed_users.some((x) => x.id === u.id)}
                      onchange={(ev) => {
                        const has = mb.allowed_users.some((x) => x.id === u.id);
                        if (ev.target.checked && !has) mb.allowed_users = [...mb.allowed_users, { id: u.id, name: u.name || u.email }];
                        if (!ev.target.checked && has) mb.allowed_users = mb.allowed_users.filter((x) => x.id !== u.id);
                        saveMbAgents(mb);
                      }}
                    />{u.name || u.email}
                  </label>
                {/each}
              </div>
            </div>
            <div class="mb-actions">
              <button class="md3-btn tonal small" onclick={() => startWatch(mb.id)} disabled={busyWatch === mb.id}>
                {busyWatch === mb.id ? "Watching…" : "Watch"}
              </button>
              <button class="md3-btn tonal small" onclick={() => toggleInbox(mb.id)} disabled={!!savingMb}>
                {mb.is_active ? "Pause" : "Activate"}
              </button>
              <button class="md3-btn tonal small danger" onclick={() => removeInbox(mb.id)} disabled={!!savingMb}>Delete</button>
            </div>
          </li>
        {:else}
          <li class="muted">No mailboxes yet — add one below.</li>
        {/each}
      </ul>

      <div class="add-inbox">
        <input type="text" bind:value={newName} placeholder="Name (Support…)" />
        <input type="email" bind:value={newEmail} placeholder="mailbox@thinkcloud.dev" />
      </div>
      <div class="add-agents">
        <span class="muted small">Agents with access:</span>
        {#each agentOptions as u (u.id)}
          <label class="ag-check">
            <input type="checkbox" checked={newUserIds.includes(u.id)} onchange={() => toggleNewAgent(u.id)} />{u.name || u.email}
          </label>
        {/each}
      </div>
      <div class="row-btns" style="margin-top:8px">
        <button class="md3-btn primary" onclick={addInbox} disabled={busyAdd || !newName.trim() || !newEmail.trim()}>
          {busyAdd ? "Adding…" : "Add mailbox"}
        </button>
      </div>
      <p class="hint">Tip: “Watch” needs a Pub/Sub topic configured in env (GOOGLE_PUBSUB_TOPIC). If you don't use Pub/Sub, enable Poll instead — new mail appears ~1 min later.</p>
    </section>

    <!-- Labels / categories -->
    <section class="card">
      <h3>Labels & categories</h3>
      <p class="muted">Extra categories you can tag onto tickets (besides the kanban statuses). Applied per-ticket from the thread panel.</p>
      <ul class="inbox-list">
        {#each labels as lb (lb.id)}
          <li>
            <span class="lbl-dot" style="background:{lb.color || '#888'}"></span>
            <span class="inbox-name">{lb.name}</span>
            <button class="md3-btn tonal small danger" onclick={() => removeLabel(lb.id)}>Delete</button>
          </li>
        {:else}
          <li class="muted">No labels yet — create some below.</li>
        {/each}
      </ul>
      <div class="add-inbox">
        <input type="text" bind:value={newLabel} placeholder="New label (e.g. VIP, Billing, Urgent)" />
        <input type="color" bind:value={newLabelColor} style="width:44px;height:40px;padding:2px" title="Label color" />
        <button class="md3-btn primary small" onclick={addLabel} disabled={!newLabel.trim()}>Add label</button>
      </div>
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

  .mb-main {
    flex: 1;
    min-width: 0;
  }

  .mb-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .mb-agents {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .ag-check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: var(--m3-type-label-sm);
    color: var(--m3-on-surface-variant);
  }

  .mb-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .add-agents {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .small {
    font: var(--m3-type-label-sm);
  }

  .lbl-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .pill.off {
    opacity: 0.55;
  }

  .danger {
    color: var(--m3-error);
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
