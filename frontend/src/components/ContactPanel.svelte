<script>
  import { appState, toast } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";
  import { timeAgo, avatarColor } from "../lib/utils.js";
  import { agentInitials, statusMeta } from "../lib/appState.svelte.js";

  let { email, inboxId, onClose } = $props();

  let contact = $state(null);
  let threads = $state([]);
  let busy = $state(false);
  let editing = $state(false);
  let edit = $state({ name: "", phone: "", company: "", title: "", notes: "", tags: [] });
  let newTag = $state("");

  async function load() {
    if (!email) return;
    const r = await api.getContact(email, true, inboxId);
    contact = r.contact || null;
    threads = r.threads || [];
  }
  $effect(() => { load(); });

  function startEdit() {
    edit = {
      name: contact?.name || "",
      phone: contact?.phone || "",
      company: contact?.company || "",
      title: contact?.title || "",
      notes: contact?.notes || "",
      tags: Array.isArray(contact?.tags) ? contact.tags : []
    };
    editing = true;
  }

  function addTag() {
    const t = newTag.trim();
    if (t && !edit.tags.includes(t)) edit.tags = [...edit.tags, t];
    newTag = "";
  }

  async function save() {
    busy = true;
    try {
      const r = await api.saveContact({
        email: email,
        name: edit.name,
        phone: edit.phone,
        company: edit.company,
        title: edit.title,
        notes: edit.notes,
        tags: edit.tags
      });
      contact = r.contact;
      editing = false;
      toast("success", "Contact saved");
    } catch (e) {
      toast("error", e?.message || "Save failed");
    } finally {
      busy = false;
    }
  }
</script>

<div class="contact-overlay" onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
  <div class="contact-panel" role="dialog" aria-modal="true" aria-label="Contact">
    <header class="cp-head">
      <h3>Contact</h3>
      <button class="md3-icon-btn" title="Close" onclick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>
      </button>
    </header>

    <div class="cp-body">
      <div class="cp-ident">
        <span class="cp-avatar" style="background:{avatarColor(email)}">{agentInitials(contact?.name || email)}</span>
        <div class="cp-idtxt">
          <strong>{contact?.name || email}</strong>
          <span class="muted">{email}</span>
        </div>
        {#if !editing}
          <button class="md3-btn tonal small" onclick={startEdit}>Edit</button>
        {/if}
      </div>

      {#if !contact && !editing}
        <p class="muted">No contact record yet — <button class="link-btn" onclick={startEdit}>create one</button> for this customer.</p>
      {/if}

      {#if editing}
        <div class="cp-fields">
          <label class="field-row"><span>Name</span><input type="text" bind:value={edit.name} /></label>
          <label class="field-row"><span>Phone</span><input type="text" bind:value={edit.phone} /></label>
          <label class="field-row"><span>Company</span><input type="text" bind:value={edit.company} /></label>
          <label class="field-row"><span>Title</span><input type="text" bind:value={edit.title} /></label>
          <div class="tag-row">
            <span class="muted">Tags</span>
            <div class="tag-list">
              {#each edit.tags as tg (tg)}
                <span class="ctag">{tg}<button onclick={() => (edit.tags = edit.tags.filter((x) => x !== tg))}>✕</button></span>
              {/each}
            </div>
            <div class="tag-add">
              <input type="text" placeholder="Add tag…" bind:value={newTag} onkeydown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addTag(); } }} />
              <button class="md3-btn tonal small" onclick={addTag}>+</button>
            </div>
          </div>
          <label class="field-row"><span>Notes</span><textarea rows="4" bind:value={edit.notes}></textarea></label>
          <div class="row-btns">
            <button class="md3-btn primary" onclick={save} disabled={busy}>Save contact</button>
            <button class="md3-btn tonal" onclick={() => (editing = false)}>Cancel</button>
          </div>
        </div>
      {:else if contact}
        <div class="cp-details">
          {#if contact.phone}<div class="kv"><span>Phone</span><b>{contact.phone}</b></div>{/if}
          {#if contact.company}<div class="kv"><span>Company</span><b>{contact.company}</b></div>{/if}
          {#if contact.title}<div class="kv"><span>Title</span><b>{contact.title}</b></div>{/if}
          {#if contact.notes}<div class="kv notes"><span>Notes</span><p>{contact.notes}</p></div>{/if}
          {#if (contact.tags || []).length}
            <div class="kv"><span>Tags</span><div class="tag-list">{#each contact.tags as tg (tg)}<span class="ctag">{tg}</span>{/each}</div></div>
          {/if}
        </div>
      {/if}

      <div class="cp-related">
        <h4>Related cases ({threads.length})</h4>
        {#if threads.length}
          <div class="rel-list">
            {#each threads as t (t.id)}
              <button class="rel-item" onclick={() => { appState.openThreadId = t.id; onClose?.(); }}>
                <span class="rel-subj">{t.subject || "(no subject)"}</span>
                <span class="rel-status" style="color:{statusMeta(t.status).dot}">{statusMeta(t.status).label}</span>
                <span class="rel-when muted">{timeAgo(t.last_message_at)}</span>
              </button>
            {/each}
          </div>
        {:else}
          <p class="muted">No other cases from this contact.</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .contact-overlay { position: fixed; inset: 0; z-index: 95; background: var(--m3-scrim); display: flex; align-items: center; justify-content: center; padding: 12px; }
  .contact-panel { width: min(480px, 96vw); max-height: 92vh; display: flex; flex-direction: column; background: var(--m3-surface-container-low); border-radius: var(--m3-shape-lg); box-shadow: var(--m3-elev-4); overflow: hidden; }
  .cp-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--m3-outline-variant); }
  .cp-head h3 { font: var(--m3-type-title-md); }
  .cp-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .cp-ident { display: flex; align-items: center; gap: 10px; }
  .cp-avatar { width: 44px; height: 44px; border-radius: 50%; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
  .cp-idtxt { flex: 1; display: flex; flex-direction: column; }
  .muted { color: var(--m3-on-surface-variant); font-size: 0.85rem; }
  .link-btn { color: var(--m3-primary); text-decoration: underline; }
  .cp-fields { display: flex; flex-direction: column; gap: 10px; }
  .field-row { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--m3-on-surface-variant); }
  .field-row input, .field-row textarea { border: 1px solid var(--m3-outline-variant); border-radius: 8px; padding: 7px 9px; background: var(--m3-surface-container-lowest); font-size: 0.9rem; }
  .tag-row { display: flex; flex-direction: column; gap: 5px; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
  .ctag { display: inline-flex; align-items: center; gap: 5px; background: var(--m3-secondary-container); color: var(--m3-on-secondary-container); border-radius: 999px; padding: 2px 8px; font-size: 0.78rem; }
  .ctag button { color: inherit; font-size: 0.7rem; }
  .tag-add { display: flex; gap: 5px; }
  .tag-add input { flex: 1; border: 1px solid var(--m3-outline-variant); border-radius: 8px; padding: 5px 8px; font-size: 0.85rem; background: var(--m3-surface-container-lowest); }
  .row-btns { display: flex; gap: 8px; margin-top: 2px; }
  .cp-details { display: flex; flex-direction: column; gap: 7px; }
  .kv { display: flex; gap: 10px; align-items: baseline; font-size: 0.85rem; }
  .kv > span { color: var(--m3-on-surface-variant); min-width: 70px; }
  .kv.notes { flex-direction: column; gap: 2px; }
  .kv.notes p { margin: 0; white-space: pre-wrap; }
  .cp-related h4 { font: var(--m3-type-title-sm); margin-bottom: 6px; }
  .rel-list { display: flex; flex-direction: column; }
  .rel-item { display: flex; align-items: center; gap: 8px; padding: 7px 4px; border-radius: 8px; }
  .rel-item:hover { background: var(--m3-row-hover); }
  .rel-subj { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88rem; }
  .rel-status { font-size: 0.75rem; font-weight: 600; }
  .rel-when { font-size: 0.75rem; flex: 0 0 auto; }
</style>
