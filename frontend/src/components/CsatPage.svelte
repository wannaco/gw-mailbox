<script>
  // Public CSAT survey page — no login. Loaded when the URL is /csat/<token>.
  import { onMount } from "svelte";
  import * as api from "../lib/api.js";

  let { token } = $props();

  let state = $state("loading"); // loading | form | done | error
  let submittedBefore = $state(false);
  let rating = $state(0);
  let hover = $state(0);
  let comment = $state("");
  let busy = $state(false);
  let errMsg = $state("");

  async function load() {
    if (!token) { state = "error"; errMsg = "Missing survey link."; return; }
    try {
      const r = await api.pbRequest("GET", `/mailbox/csat/${encodeURIComponent(token)}`);
      if (r && r.ok) {
        submittedBefore = !!r.submitted;
        state = submittedBefore ? "done" : "form";
      } else {
        state = "error"; errMsg = (r && r.message) || "Survey not found.";
      }
    } catch (e) {
      // treat 404 as not found
      state = "error";
      errMsg = (e && (e.data?.message || e.message)) || "Survey not found.";
    }
  }
  onMount(load);

  async function submit() {
    if (!rating || busy) return;
    busy = true;
    errMsg = "";
    try {
      await api.pbRequest("POST", "/mailbox/csat/submit", { token, rating, comment });
      state = "done";
    } catch (e) {
      errMsg = (e && (e.data?.message || e.message)) || "Could not submit. Please try again.";
      if (e && e.status === 409) state = "done"; // already answered
    } finally {
      busy = false;
    }
  }

  const stars = [1, 2, 3, 4, 5];
  const LABELS = ["Very poor", "Poor", "Okay", "Good", "Excellent"];
</script>

<div class="csat-page">
  <div class="csat-card">
    <div class="csat-brand">
      <span class="brand-dot"></span>
      <span>Mailbox</span>
    </div>

    {#if state === "loading"}
      <p class="csat-muted">Loading…</p>
    {:else if state === "error"}
      <h1>Link not found</h1>
      <p class="csat-muted">{errMsg}</p>
    {:else if state === "done"}
      <h1>Thank you! 🎉</h1>
      <p class="csat-muted">Your feedback helps us keep improving. Have a great day!</p>
    {:else}
      <h1>How did we do?</h1>
      <p class="csat-muted">Please rate your support experience (1–5 stars).</p>

      <div class="csat-stars" role="radiogroup" aria-label="Rating">
        {#each stars as s (s)}
          <button
            type="button"
            class="star"
            class:on={rating >= s}
            aria-label={`${s} star${s === 1 ? "" : "s"} — ${LABELS[s - 1]}`}
            onmouseenter={() => (hover = s)}
            onmouseleave={() => (hover = 0)}
            onclick={() => (rating = s)}
          >
            <svg width="34" height="34" viewBox="0 0 24 24">
              <path d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.3l7.1-.7z" fill="currentColor"/>
            </svg>
          </button>
        {/each}
      </div>
      {#if rating}
        <p class="csat-label">{LABELS[rating - 1]}</p>
      {/if}

      <textarea
        class="csat-comment"
        rows="3"
        maxlength="5000"
        placeholder="Anything else you'd like to tell us? (optional)"
        bind:value={comment}
      ></textarea>

      {#if errMsg}<p class="csat-err">{errMsg}</p>{/if}

      <button class="csat-submit" onclick={submit} disabled={!rating || busy}>
        {busy ? "Sending…" : "Submit feedback"}
      </button>
    {/if}
  </div>
</div>

<style>
  .csat-page {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: var(--m3-surface);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .csat-card {
    width: min(460px, 100%);
    background: var(--m3-surface-container-low, #fff);
    border: 1px solid var(--m3-outline-variant, #e0e0e0);
    border-radius: 16px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
    padding: 26px 26px 30px;
    text-align: center;
    color: var(--m3-on-surface, #1a1a1a);
  }
  .csat-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-weight: 700;
    color: var(--m3-on-surface-variant, #5f6368);
    margin-bottom: 14px;
  }
  .brand-dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #0b57d0;
    display: inline-block;
  }
  .csat-card h1 {
    font-size: 1.4rem;
    margin: 4px 0 6px;
  }
  .csat-muted { color: var(--m3-on-surface-variant, #5f6368); font-size: 0.92rem; }
  .csat-stars {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin: 16px 0 4px;
  }
  .star {
    background: none;
    border: 0;
    cursor: pointer;
    color: var(--m3-outline, #b0b0b0);
    padding: 2px;
    transition: transform 0.1s ease, color 0.1s ease;
  }
  .star.on { color: var(--m3-warning); }
  .star:hover { transform: scale(1.12); }
  .csat-label { font-weight: 600; color: var(--m3-on-surface, #1a1a1a); min-height: 1.2em; margin: 6px 0 10px; }
  .csat-comment {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--m3-outline-variant, #e0e0e0);
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    font-size: 0.92rem;
    resize: vertical;
    background: var(--m3-surface-container-lowest, #fff);
    color: inherit;
  }
  .csat-err { color: var(--m3-danger); font-size: 0.85rem; margin: 8px 0 0; }
  .csat-submit {
    margin-top: 14px;
    width: 100%;
    padding: 11px;
    border: 0;
    border-radius: 999px;
    background: #0b57d0;
    color: #fff;
    font: inherit;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }
  .csat-submit:disabled { opacity: 0.55; cursor: default; }
</style>
