<script lang="ts">
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import type { BackfillEventView } from "./+page.server";

  let {
    data,
  }: {
    data: {
      events: BackfillEventView[];
      nextCursor: string | null;
      filters: { job: string; type: string; outcome: string; q: string };
      jobs: readonly string[];
      outcomes: readonly string[];
      types: readonly string[];
    };
  } = $props();

  function linkFor(event: BackfillEventView): string {
    if (event.resourceType === "work") return `/works/${event.linkRkey}`;
    if (event.resourceType === "contributor") return `/contributors/${event.linkRkey}`;
    return `/editions/${event.linkRkey}`;
  }

  function formatWhen(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return iso;
    const diffMs = Date.now() - then;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function queryString(next: string | null): string {
    const params = new URLSearchParams();
    if (data.filters.job) params.set("job", data.filters.job);
    if (data.filters.type) params.set("type", data.filters.type);
    if (data.filters.outcome) params.set("outcome", data.filters.outcome);
    if (data.filters.q) params.set("q", data.filters.q);
    if (next) params.set("cursor", next);
    return params.toString();
  }

  const outcomeTone: Record<string, string> = {
    updated: "ok",
    created: "ok",
    miss: "neutral",
    deferred: "warn",
    blocked: "warn",
    invalid: "warn",
    failed: "danger",
  };
</script>

<main>
  <h1>Backfill audit</h1>
  <p class="lede">
    History of what the backfill jobs did, newest first. Click a resource to open it.
    Events are recorded from the deploy that introduces the table onward —
    earlier runs are not retroactively logged.
  </p>

  <form method="GET" class="filters">
    <label>
      Job
      <select name="job">
        <option value="">(all)</option>
        {#each data.jobs as job}
          <option value={job} selected={data.filters.job === job}>{job}</option>
        {/each}
      </select>
    </label>
    <label>
      Resource
      <select name="type">
        <option value="">(all)</option>
        {#each data.types as type}
          <option value={type} selected={data.filters.type === type}>{type}</option>
        {/each}
      </select>
    </label>
    <label>
      Outcome
      <select name="outcome">
        <option value="">(all)</option>
        {#each data.outcomes as outcome}
          <option value={outcome} selected={data.filters.outcome === outcome}>{outcome}</option>
        {/each}
      </select>
    </label>
    <label>
      Search
      <input type="search" name="q" value={data.filters.q} placeholder="uri or title" />
    </label>
    <button type="submit">Filter</button>
    {#if data.filters.job || data.filters.type || data.filters.outcome || data.filters.q}
      <a class="muted small" href="/admin/backfills">Clear</a>
    {/if}
  </form>

  {#if data.events.length === 0}
    <p class="muted">No backfill events recorded yet.</p>
  {:else}
    <ul class="queue">
      {#each data.events as event}
        <li>
          <div class="row">
            <div class="what">
              <span class="badge job">{event.job}</span>
              <a class="resource" href={linkFor(event)}>
                <strong>{event.label ?? event.resourceUri}</strong>
                <span class="muted small">{event.resourceType} · {event.resourceRkey}</span>
              </a>
              {#if event.thumb}
                <img class="thumb" src={event.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {/if}
            </div>
            <div class="meta">
              <span class="badge outcome {outcomeTone[event.outcome] ?? 'neutral'}">
                {event.outcome}
              </span>
              <span class="muted small" title={event.occurredAt}>{formatWhen(event.occurredAt)}</span>
              <span class="muted small">attempt {event.attempts}/{event.maxAttempts}</span>
              {#if event.durationMs !== null}
                <span class="muted small">{event.durationMs}ms</span>
              {/if}
              {#if event.origin}
                <span class="muted small">via {event.origin}</span>
              {/if}
            </div>
          </div>
          {#if event.reason && event.reason !== 'ok'}
            <code class="reason">{event.reason}</code>
          {/if}
          {#if event.error}
            <code class="error" title={event.error}>{event.error.slice(0, 160)}</code>
          {/if}
        </li>
      {/each}
    </ul>

    {#if data.nextCursor}
      <p><a class="muted" href={`?${queryString(data.nextCursor)}`}>Older →</a></p>
    {/if}
  {/if}
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 64rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-m); }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: flex-end;
    margin-block-end: var(--wa-space-m);
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-on-quiet);
  }
  .filters select,
  .filters input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
    color: var(--wa-color-text-normal);
  }
  .filters button {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
    color: var(--wa-color-text-normal);
    cursor: pointer;
  }

  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  .queue li {
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
    align-items: center;
  }
  .what {
    display: flex;
    gap: var(--wa-space-s);
    align-items: center;
    min-width: 0;
  }
  .resource {
    color: var(--wa-color-text-normal);
    text-decoration: none;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .resource strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 32rem;
  }
  .resource:hover strong { text-decoration: underline; }
  .thumb {
    width: 2.5rem;
    height: 2.5rem;
    object-fit: cover;
    border-radius: var(--wa-border-radius-s);
    flex: none;
  }
  .meta {
    display: flex;
    gap: var(--wa-space-s);
    align-items: center;
    flex-wrap: wrap;
  }
  .reason,
  .error {
    display: block;
    margin-block-start: var(--wa-space-s);
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-on-quiet);
    overflow-wrap: anywhere;
  }
  .error { color: var(--wa-color-danger-60); }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: var(--wa-border-radius-m);
    border: 1px solid var(--wa-form-control-border-color);
    font-size: var(--wa-font-size-xs);
    white-space: nowrap;
  }
  .outcome.ok { border-color: var(--wa-color-success-50); color: var(--wa-color-success-50); }
  .outcome.warn { border-color: var(--wa-color-warning-50); color: var(--wa-color-warning-50); }
  .outcome.danger { border-color: var(--wa-color-danger-50); color: var(--wa-color-danger-50); }
  .outcome.neutral { color: var(--wa-color-on-quiet); }
  .muted { color: var(--wa-color-on-quiet); }
  .small { font-size: var(--wa-font-size-xs); }
</style>
