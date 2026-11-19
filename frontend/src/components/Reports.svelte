<script>
  // Reports — live aggregates over the inboxes the signed-in user can see.
  import { appState, STATUSES, statusMeta } from "../lib/appState.svelte.js";
  import * as api from "../lib/api.js";

  let data = $state(null);
  let error = $state("");
  let loading = $state(true);

  // Scope. "" inbox = every mailbox the user may see; range defaults to all
  // time so the first view matches the previous behaviour exactly.
  let selInbox = $state("");
  let selRange = $state("all");

  const RANGES = [
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
    { value: "quarter", label: "Quarter" },
    { value: "year", label: "Year" },
    { value: "all", label: "All time" }
  ];

  async function load() {
    loading = true;
    error = "";
    try {
      const r = await api.getReports({ inbox: selInbox, range: selRange });
      data = r;
    } catch (e) {
      error = e?.message || "Could not load reports";
    } finally {
      loading = false;
    }
  }

  // Re-fetch whenever the scope changes. $effect tracks selInbox/selRange, so
  // changing either picker reloads on its own.
  $effect(() => {
    selInbox;
    selRange;
    load();
  });

  // Degraded case: the response carries no `scope` (older server build) —
  // keep the mailboxes picker usable via the session's inbox list.
  const mailboxOptions = $derived(
    (data?.inboxes?.length
      ? data.inboxes
      : (appState.inboxes || []).map((i) => ({ id: i.id, name: i.name || i.email_address || i.id }))
    ).slice()
  );

  const fmt = (n) => Number(n || 0).toLocaleString();

  // avgHours -> "1h 20m" / "3d 4h" / "45m" (— when none)
  function fmtDur(h) {
    if (!h || h <= 0) return "—";
    const mins = Math.round(h * 60);
    if (mins < 60) return mins + "m";
    if (h < 48) {
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      return hh + "h" + (mm ? " " + mm + "m" : "");
    }
    const dd = Math.floor(h / 24);
    const hh = Math.round(h % 24);
    return dd + "d" + (hh ? " " + hh + "h" : "");
  }

  const pct = (n, max) => (n > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0);
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? "" : "s"}`;

  // Bar-ish helpers for a tiny CSS distribution chart.
  function maxKey(obj) {
    let m = 0;
    for (const k in obj || {}) m = Math.max(m, obj[k] || 0);
    return m || 1;
  }
</script>

<div class="reports">
  <header class="page-head">
    <div>
      <h1 class="page-title">Reports</h1>
      <p class="page-sub">Volume, SLA and response times across your mailboxes.</p>
    </div>
    <button class="refresh" onclick={load} disabled={loading}>
      <svg class:spin={loading} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  </header>

  <!-- Filters in one row above everything they scope. -->
  <div class="scope">
    <label class="pick">
      <span class="sr-only">Mailbox</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z"/></svg>
      <select bind:value={selInbox} disabled={loading}>
        <option value="">All mailboxes</option>
        {#each mailboxOptions as ib (ib.id)}
          <option value={ib.id}>{ib.name}</option>
        {/each}
      </select>
      <svg class="caret" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
    </label>

    <div class="range-group" role="group" aria-label="Time range">
      {#each RANGES as r (r.value)}
        <button
          type="button"
          class="range-btn"
          class:on={selRange === r.value}
          aria-pressed={selRange === r.value}
          onclick={() => (selRange = r.value)}
          disabled={loading}
        >{r.label}</button>
      {/each}
    </div>

    {#if data?.scope}
      <p class="scope-note" aria-live="polite">
        {data.scope.inboxName} · {data.scope.rangeLabel}{#if data.scope.range !== "all" && data.scope.since} · since {data.scope.since.slice(0, 10)}{/if}
      </p>
    {/if}
  </div>
  {#if data?.scope && selRange !== "all"}
    <p class="scope-hint">Counts conversations with activity in this period.</p>
  {/if}

  {#if error}
    <div class="card err" role="alert"><strong>{error}</strong></div>
  {:else if !data}
    <p class="muted">Loading…</p>
  {:else}
    <!-- Stat tiles: label, then the value. Values wear text ink; the only
         colour is SLA overdue's status treatment (icon + tint + label). -->
    <div class="tiles">
      <div class="tile">
        <span class="t-label">Open</span>
        <span class="t-value">{fmt(data.totals.open)}</span>
      </div>
      <div class="tile">
        <span class="t-label">Closed</span>
        <span class="t-value">{fmt(data.totals.closed)}</span>
      </div>
      <div class="tile" class:alert={data.sla.overdue > 0}>
        <span class="t-label">
          {#if data.sla.overdue > 0}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          {/if}
          SLA overdue
        </span>
        <span class="t-value">{fmt(data.sla.overdue)}</span>
      </div>
      <div class="tile">
        <span class="t-label">Avg CSAT</span>
        <span class="t-value">{data.csat.responses ? data.csat.average : "—"}{#if data.csat.responses}<span class="t-unit"> / 5</span>{/if}</span>
        <span class="t-sub">{plural(data.csat.responses || 0, "response")}</span>
      </div>
      <div class="tile">
        <span class="t-label">Avg first response</span>
        <span class="t-value">{fmtDur(data.responsiveness?.firstResponse.avgHours)}</span>
        <span class="t-sub">{plural(data.responsiveness?.firstResponse.count || 0, "ticket")}</span>
      </div>
      <div class="tile">
        <span class="t-label">Avg resolution</span>
        <span class="t-value">{fmtDur(data.responsiveness?.resolution.avgHours)}</span>
        <span class="t-sub">{plural(data.responsiveness?.resolution.count || 0, "ticket")}</span>
      </div>
    </div>

    <div class="panels">
      <section class="card" aria-labelledby="rep-status">
        <h2 id="rep-status">By status</h2>
        <ul class="bars">
          {#each STATUSES as st (st.value)}
            {@const n = data.byStatus[st.value] || 0}
            <li class="bar-row" title={`${st.label}: ${plural(n, "conversation")}`}>
              <span class="bar-name"><span class="bdot" style="background:{st.dot}" aria-hidden="true"></span>{st.label}</span>
              <span class="bar" aria-hidden="true"><span class="bar-fill" style="width:{pct(n, maxKey(data.byStatus))}%;background:{st.dot}"></span></span>
              <span class="bar-num">{fmt(n)}</span>
            </li>
          {/each}
        </ul>
        <p class="hint">Spam and archived are excluded from Open/Closed but shown here.</p>
      </section>

      <section class="card" aria-labelledby="rep-inbox">
        <h2 id="rep-inbox">By mailbox</h2>
        {#if data.byInbox.length}
          {@const maxIb = Math.max(1, ...data.byInbox.map((x) => x.count))}
          <ul class="bars">
            {#each data.byInbox as ib (ib.id)}
              <li class="bar-row" title={`${ib.name}: ${plural(ib.count, "conversation")}`}>
                <span class="bar-name">{ib.name}</span>
                <span class="bar" aria-hidden="true"><span class="bar-fill" style="width:{pct(ib.count, maxIb)}%;background:var(--m3-primary)"></span></span>
                <span class="bar-num">{fmt(ib.count)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted">No mailboxes.</p>
        {/if}
      </section>

      <section class="card wide" aria-labelledby="rep-agents">
        <h2 id="rep-agents">Agents</h2>
        {#if data.agents.length}
          <div class="table-wrap">
            <table class="rep-table">
              <caption class="sr-only">Conversations per agent</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" class="num">Open</th>
                  <th scope="col" class="num">Closed</th>
                  <th scope="col" class="num">Total</th>
                  <th scope="col" class="num">First replies</th>
                </tr>
              </thead>
              <tbody>
                {#each data.agents as a (a.id)}
                  <tr>
                    <th scope="row">{a.name}</th>
                    <td class="num">{fmt(a.open)}</td>
                    <td class="num">{fmt(a.closed)}</td>
                    <td class="num">{fmt(a.total)}</td>
                    <td class="num">{fmt(a.first_responses || 0)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="hint">First response = first agent reply − arrival. Resolution = close − arrival. Both fill in as agents reply to and close tickets.</p>
        {:else}
          <p class="muted">No assigned tickets yet. Assign tickets to agents to see per-agent volume here ({data.byAssignee.unassignedOpen || 0} open unassigned).</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .reports {
    max-width: 1040px;
    margin: 0 auto;
    padding: 28px 24px 60px;
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box;
  }

  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: var(--m3-shape-full);
    border: 1px solid var(--m3-outline-variant);
    background: var(--m3-surface-raised);
    color: var(--m3-on-surface);
    font: var(--m3-type-label-lg);
  }
  .refresh:hover:not(:disabled) { background: var(--m3-row-hover); }
  .refresh:disabled { opacity: 0.6; }
  .spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---- filters */
  .scope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    margin-bottom: 6px;
  }
  .pick {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 8px 0 12px;
    border: 1px solid var(--m3-outline-variant);
    border-radius: var(--m3-shape-full);
    background: var(--m3-surface-raised);
    color: var(--m3-on-surface-variant-2);
  }
  .pick:focus-within { border-color: var(--m3-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--m3-primary) 16%, transparent); }
  .pick select {
    appearance: none;
    -webkit-appearance: none;
    border: 0;
    background: none;
    outline: none;
    height: 100%;
    padding: 0 22px 0 0;
    margin-right: -22px;
    font: var(--m3-type-label-lg);
    color: var(--m3-on-surface);
    cursor: pointer;
    field-sizing: content;
  }
  .caret { pointer-events: none; }

  .range-group {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    background: var(--m3-surface-container);
    border-radius: var(--m3-shape-full);
  }
  .range-btn {
    height: 28px;
    padding: 0 12px;
    border-radius: var(--m3-shape-full);
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
  }
  .range-btn:hover:not(:disabled):not(.on) { color: var(--m3-on-surface); }
  .range-btn.on { background: var(--m3-surface-raised); color: var(--m3-on-surface); font-weight: 600; box-shadow: var(--m3-elev-1); }
  .range-btn:disabled { cursor: default; }

  .scope-note {
    margin: 0 0 0 auto;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface-variant-2);
  }
  .scope-hint { margin: 0 0 4px; font: var(--m3-type-body-sm); color: var(--m3-on-surface-variant-2); }

  .muted { color: var(--m3-on-surface-variant); font: var(--m3-type-body-sm); }
  .hint { margin: 14px 0 0; font: var(--m3-type-body-sm); color: var(--m3-on-surface-variant-2); }

  /* ---- stat tiles */
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin: 18px 0 16px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 18px;
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 75%, transparent);
    border-radius: var(--m3-shape-lg);
    box-shadow: 0 1px 2px rgb(15 40 80 / 0.05);
  }
  .t-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: var(--m3-type-label-md);
    color: var(--m3-on-surface-variant);
  }
  .t-value {
    font: 600 1.875rem / 1.1 "Inter", system-ui, sans-serif;
    letter-spacing: -0.02em;
    color: var(--m3-on-surface);
    font-variant-numeric: tabular-nums;
  }
  .t-unit { font-size: 1rem; font-weight: 500; color: var(--m3-on-surface-variant-2); letter-spacing: 0; }
  .t-sub { font: var(--m3-type-body-sm); color: var(--m3-on-surface-variant-2); }
  .tile.alert {
    background: color-mix(in srgb, var(--sla-breached) 7%, var(--m3-surface-raised));
    border-color: color-mix(in srgb, var(--sla-breached) 30%, transparent);
  }
  .tile.alert .t-label { color: var(--sla-breached-ink); font-weight: 600; }

  /* ---- panels */
  .panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .card {
    background: var(--m3-surface-raised);
    border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 75%, transparent);
    border-radius: var(--m3-shape-lg);
    padding: 18px 20px;
    box-shadow: 0 1px 2px rgb(15 40 80 / 0.05);
    min-width: 0;
  }
  .card.wide { grid-column: 1 / -1; }
  .card h2 { font: var(--m3-type-title-sm); margin: 0 0 14px; color: var(--m3-on-surface); }
  .card.err { color: var(--m3-error); }

  /* Thin bars, rounded ends, track one step lighter than the page. Labels
     and numbers are text ink; the dot and the fill carry the status hue. */
  .bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 40px; align-items: center; gap: 12px; }
  .bar-name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font: var(--m3-type-body-sm);
    color: var(--m3-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .bar { height: 8px; background: var(--m3-surface-container); border-radius: 999px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 999px; transition: width 0.3s ease; }
  .bar-num { text-align: right; font: var(--m3-type-label-md); color: var(--m3-on-surface-variant); font-variant-numeric: tabular-nums; }

  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -6px; }
  .rep-table { width: 100%; border-collapse: collapse; font: var(--m3-type-body-md); }
  .rep-table th, .rep-table td { text-align: left; padding: 10px 6px; border-bottom: 1px solid color-mix(in srgb, var(--m3-outline-variant) 70%, transparent); }
  .rep-table thead th {
    font: var(--m3-type-label-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--m3-on-surface-variant-2);
    padding-top: 0;
  }
  .rep-table tbody th { font-weight: 500; color: var(--m3-on-surface); }
  .rep-table tbody tr:last-child > * { border-bottom: 0; }
  .rep-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  @media (hover: hover) { .rep-table tbody tr:hover { background: var(--m3-row-hover); } }

  @media (max-width: 760px) {
    .reports { padding: 18px 14px 32px; }
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .tile { padding: 14px; }
    .t-value { font-size: 1.5rem; }
    .panels { grid-template-columns: 1fr; }
    .card { padding: 16px; }
    .bar-row { grid-template-columns: 136px minmax(0, 1fr) 28px; gap: 10px; }
    .scope-note { flex-basis: 100%; margin: 0; }
    .range-group { overflow-x: auto; max-width: 100%; }
  }
</style>
