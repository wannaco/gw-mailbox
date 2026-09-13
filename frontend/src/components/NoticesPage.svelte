<script>
  // Third-party license notices — public page, no login required.
  //
  // Rendered when the URL is /notices. The license texts are NOT duplicated
  // here: they are read at runtime from /THIRD_PARTY_NOTICES.txt, which is the
  // same file baked into the container (see Dockerfile) — so the page and the
  // shipped artifact can never drift apart. Only the short per-component
  // metadata below is declared in code, because it drives the layout.
  import { onMount } from "svelte";

  let sections = $state([]); // [{ name, body }] parsed from the notices file
  let failed = $state(false);
  let loading = $state(true);

  // Card metadata, matched to the parsed sections by name prefix.
  const META = [
    {
      match: "PocketBase",
      role: "Backend runtime — database, REST API, realtime and the admin dashboard.",
      licence: "MIT",
      holder: "© 2022–present, Gani Georgiev",
      url: "https://github.com/pocketbase/pocketbase",
      note: "Distributed as the pocketbase binary and run as the application's backend."
    },
    {
      match: "Svelte",
      role: "Front-end framework — compiled into the interface you are using now.",
      licence: "MIT",
      holder: "© 2016–2025, Svelte Contributors",
      url: "https://github.com/sveltejs/svelte",
      note: "Compiled into the shipped JavaScript bundle."
    },
    {
      match: "Inter",
      role: "Typeface used throughout the interface.",
      licence: "SIL OFL 1.1",
      holder: "© 2016, The Inter Project Authors",
      url: "https://github.com/rsms/inter",
      note: "Bundled as WOFF2 webfonts via @fontsource/inter. Used unmodified; the reserved font name is not used as this product's name."
    }
  ];

  // The notice file is markdown with one "## <component>" section per entry.
  // Split on those headings; everything after the heading is that component's
  // license text plus a trailing "---" rule.
  function parse(md) {
    const first = md.indexOf("\n## ");
    const rest = first === -1 ? md : md.slice(first + 1);
    return rest
      .split(/^## /m)
      .filter((p) => p.trim())
      .map((p) => {
        const nl = p.indexOf("\n");
        const name = (nl === -1 ? p : p.slice(0, nl)).trim();
        const body = (nl === -1 ? "" : p.slice(nl + 1))
          .replace(/^-{3,}\s*$/gm, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return { name, body, meta: META.find((m) => name.startsWith(m.match)) || null };
      });
  }

  onMount(async () => {
    try {
      const res = await fetch("/THIRD_PARTY_NOTICES.txt", { cache: "no-cache" });
      if (!res.ok) throw new Error(String(res.status));
      sections = parse(await res.text()).filter((s) => s.meta);
      if (!sections.length) failed = true;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>Third-party notices</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="page">
  <div class="wrap">
    <div class="brand">
      <span class="brand-dot"></span>
      <span>Mailbox</span>
    </div>

    <h1>Third-party notices</h1>
    <p class="intro">
      This software is built on the work of others. The components below are included in
      what you were given, and each is used under its own license — reproduced in full here.
    </p>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if failed}
      <div class="card">
        <p><strong>Could not load the notices file.</strong></p>
        <p class="muted">
          It is shipped with the software and served at
          <a href="/THIRD_PARTY_NOTICES.txt">/THIRD_PARTY_NOTICES.txt</a> — open that directly.
        </p>
      </div>
    {:else}
      {#each sections as s}
        <section class="card">
          <div class="head">
            <h2>{s.meta.match}</h2>
            <span class="chip">{s.meta.licence}</span>
          </div>
          <p class="role">{s.meta.role}</p>
          <p class="holder">{s.meta.holder}</p>
          <p class="note">{s.meta.note}</p>
          <p class="link">
            <a href={s.meta.url} target="_blank" rel="noopener">Project source ↗</a>
          </p>
          <details>
            <summary>Full license text</summary>
            <pre>{s.body}</pre>
          </details>
        </section>
      {/each}

      <p class="foot">
        Complete notices, including the license of the application's own code, also ship with
        the software as <code>THIRD_PARTY_NOTICES.md</code> and at
        <a href="/THIRD_PARTY_NOTICES.txt">/THIRD_PARTY_NOTICES.txt</a>.
      </p>
      <p class="foot">
        <a href="/">← Back to Mailbox</a>
      </p>
    {/if}
  </div>
</div>

<style>
  .page {
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--m3-surface, #fff);
    color: var(--m3-on-surface, #1a1a1a);
    padding: 40px 20px 70px;
    box-sizing: border-box;
    overflow-y: auto;
  }

  .wrap { max-width: 720px; margin: 0 auto; }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font: var(--m3-type-title-sm, 600 0.875rem/1.35 Inter, sans-serif);
    color: var(--m3-on-surface-variant, #5f6368);
    margin-bottom: 22px;
  }
  .brand-dot {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--m3-primary, #0b57d0);
  }

  h1 {
    font: var(--m3-type-headline, 600 1.375rem/1.25 Inter, sans-serif);
    margin: 0 0 10px;
  }

  .intro {
    font: var(--m3-type-body-md, 0.875rem/1.4 Inter, sans-serif);
    color: var(--m3-on-surface-variant-2, #5f6368);
    margin: 0 0 26px;
    max-width: 60ch;
  }

  .card {
    background: var(--m3-surface-container-low, #fff);
    border: 1px solid var(--m3-outline-variant, #dadce0);
    border-radius: var(--m3-shape-md, 12px);
    padding: 18px 20px;
    margin-bottom: 14px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  h2 { font: var(--m3-type-title-lg, 600 1.125rem/1.3 Inter, sans-serif); margin: 0; }

  .chip {
    flex: none;
    font: var(--m3-type-label-sm, 500 0.6875rem/1 Inter, sans-serif);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: var(--m3-surface-container-high, #f1f3f4);
    color: var(--m3-on-surface-variant, #5f6368);
    border-radius: var(--m3-shape-xs, 6px);
    padding: 4px 8px;
  }

  .role { font: var(--m3-type-body-md, 0.875rem/1.4 Inter, sans-serif); margin: 0 0 4px; }
  .holder { font: var(--m3-type-body-md, 0.875rem/1.4 Inter, sans-serif); margin: 0; color: var(--m3-on-surface-variant-2, #5f6368); }
  .note { font: var(--m3-type-body-sm, 0.75rem/1.35 Inter, sans-serif); color: var(--m3-on-surface-variant-2, #5f6368); margin: 8px 0 0; }
  .link { margin: 10px 0 0; font: var(--m3-type-body-sm, 0.75rem/1.35 Inter, sans-serif); }

  details { margin-top: 14px; border-top: 1px solid var(--m3-outline-variant, #dadce0); padding-top: 12px; }
  summary {
    cursor: pointer;
    font: var(--m3-type-label-md, 500 0.8125rem/1.2 Inter, sans-serif);
    color: var(--m3-primary, #0b57d0);
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  summary::-webkit-details-marker { display: none; }

  /* Caret drawn in CSS, not a text glyph — the bundled Inter subset has no
     fullwidth/symbol characters, so a "+" character renders as tofu. */
  summary::before {
    content: "";
    flex: none;
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 0.15s ease;
  }
  details[open] summary::before { transform: rotate(90deg); }
  summary:hover { text-decoration: underline; }

  pre {
    margin: 12px 0 0;
    padding: 14px;
    background: var(--m3-surface-container, #f8f9fa);
    border: 1px solid var(--m3-outline-variant, #dadce0);
    border-radius: var(--m3-shape-sm, 8px);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 340px;
    overflow-y: auto;
    color: var(--m3-on-surface-variant, #3c4043);
  }

  a { color: var(--m3-primary, #0b57d0); }
  .muted { color: var(--m3-on-surface-variant-2, #5f6368); font: var(--m3-type-body-md, 0.875rem/1.4 Inter, sans-serif); }

  .foot {
    font: var(--m3-type-body-sm, 0.75rem/1.5 Inter, sans-serif);
    color: var(--m3-on-surface-variant-2, #5f6368);
    margin: 22px 0 0;
  }
  code {
    background: var(--m3-surface-container-high, #f1f3f4);
    border-radius: 4px;
    padding: 1px 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  @media (max-width: 560px) {
    .head { flex-wrap: wrap; }
  }
</style>
