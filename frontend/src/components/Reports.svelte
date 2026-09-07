<script>
  // Reports — live aggregates over the inboxes the signed-in user can see.
  import { appState, STATUSES, statusMeta } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";

  let data = $state(null);
  let error = $state("");
  let loading = $state(true);

  async function load() {
    loading = true;
    error = "";
    try {
      const r = await api.getReports();
      data = r;
    } catch (e) {
      error = e?.message || "Could not load reports";
    } finally {
      loading = false;
    }
  }
  $effect(() => { load(); });

  const fmt = (n) => Number(n || 0).toLocaleString();

  // Bar-ish helpers for a tiny CSS distribution chart.
  function maxKey(obj) {
    let m = 0;
    for (const k in obj || {}) m = Math.max(m, obj[k] || 0);
    return m || 1;
  }
</script>

<div class="reports">
  <div class="rep-head">
    <h2>Reports</h2>
    <button class="md3-btn tonal small" onclick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
  </div>

  {#if error}
    <div class="card err"><strong>{error}</strong></div>
  {:else if !data}
    <p class="muted">Loading…</p>
  {:else}
    <div class="cards">
      <div class="stat">
        <span class="stat-num">{fmt(data.totals.open)}</span>
        <span class="stat-label">Open</span>
      </div>
      <div class="stat">
        <span class="stat-num">{fmt(data.totals.closed)}</span>
        <span class="stat-label">Closed</span>
      </div>
      <div class="stat warn">
        <span class="stat-num">{fmt(data.sla.overdue)}</span>
        <span class="stat-label">SLA overdue</span>
      </div>
      <div class="stat good">
        <span class="stat-num">{data.csat.responses ? data.csat.average + "★" : "—"}</span>
        <span class="stat-label">Avg CSAT ({data.csat.responses})</span>
      </div>
    </div>

    <div class="panels">
      <div class="card">
        <h3>By status</h3>
        {#each STATUSES as s (s.value)}
          {@const n = data.byStatus[s.value] || 0}
          <div class="bar-row">
            <span class="bar-name" style="color:{s.dot}">{s.label}</span>
            <div class="bar"><div class="bar-fill" style="width:{Math.round((n / maxKey(data.byStatus)) * 100)}%;background:{s.dot}"></div></div>
            <span class="bar-num">{n}</span>
          </div>
        {/each}
        <p class="muted hint">Spam/archived excluded from open/closed but shown here.</p>
      </div>

      <div class="card">
        <h3>Inboxes</h3>
        {#if data.byInbox.length}
          {#each data.byInbox as ib (ib.id)}
            <div class="bar-row">
              <span class="bar-name">{ib.name}</span>
              <div class="bar"><div class="bar-fill" style="width:{Math.round((ib.count / Math.max(1, Math.max(...data.byInbox.map((x) => x.count)))) * 100)}%;background:var(--m3-primary)"></div></div>
              <span class="bar-num">{ib.count}</span>
            </div>
          {/each}
        {:else}
          <p class="muted">No inboxes.</p>
        {/if}
      </div>

      <div class="card">
        <h3>Agents</h3>
        {#if data.agents.length}
          <table class="rep-table">
            <thead><tr><th>Agent</th><th>Open</th><th>Closed</th><th>Total</th></tr></thead>
            <tbody>
              {#each data.agents as a (a.id)}
                <tr><td>{a.name}</td><td>{a.open}</td><td>{a.closed}</td><td>{a.total}</td></tr>
              {/each}
            </tbody>
          </table>
          <p class="muted hint">First-response + resolution-time trends start populating as tickets are handled (first_response_at / closed_at now stamped automatically).</p>
        {:else}
          <p class="muted">No assigned tickets yet — assign tickets to agents to see per-agent volume here. ({data.byAssignee.unassignedOpen || 0} open unassigned)</p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .reports {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 20px 60px;
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box;
  }
  .rep-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  h2 { font: var(--m3-type-headline); margin: 0; }
  .muted { color: var(--m3-on-surface-variant); font: var(--m3-type-body-sm); }
  .hint { margin-top: 10px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .stat {
    background: var(--m3-surface-container-low);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    padding: 14px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .stat-num { font: var(--m3-type-headline); font-weight: 700; }
  .stat-label { font: var(--m3-type-label-md); color: var(--m3-on-surface-variant); }
  .stat.warn .stat-num { color: #ba1a1a; }
  .stat.good .stat-num { color: #188038; }

  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .card {
    background: var(--m3-surface-container-low);
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-md);
    padding: 16px;
  }
  .card h3 { font: var(--m3-type-title-md); margin: 0 0 12px; }
  .card.err { color: var(--m3-error); }

  .bar-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .bar-name { width: 120px; font: var(--m3-type-label-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { flex: 1; height: 10px; background: var(--m3-surface-container-highest); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.3s ease; }
  .bar-num { width: 34px; text-align: right; font: var(--m3-type-label-md); color: var(--m3-on-surface-variant); }

  .rep-table { width: 100%; border-collapse: collapse; font: var(--m3-type-body-sm); }
  .rep-table th, .rep-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--m3-outline-variant); }
  .rep-table th { color: var(--m3-on-surface-variant); font-weight: 600; }
</style>
