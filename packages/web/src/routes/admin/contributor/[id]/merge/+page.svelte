<script lang="ts">
  import type {
    AdminContributorRecord,
    AdminEntityMatch,
    AdminEntitySearchResponse,
    ContributorMergePlan
  } from '$lib/admin/types';

  type MergeData = {
    source: AdminContributorRecord;
    target: AdminContributorRecord | null;
    plan: ContributorMergePlan | null;
    into: string;
    targetError: string | null;
  };

  let {
    data,
    form
  }: { data: MergeData; form: { message?: string } | null } = $props();

  let query = $state('');
  let candidates = $state<AdminEntityMatch[]>([]);
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function valueOf(event: Event): string {
    const target = event.currentTarget as EventTarget & { value?: unknown };
    return typeof target.value === 'string' ? target.value : '';
  }

  function identifiersOf(match: AdminEntityMatch): string {
    return match.identifiers.length === 0
      ? 'no identifiers'
      : match.identifiers.map((identifier) => `${identifier.issuer}:${identifier.value}`).join(', ');
  }

  async function search(value: string): Promise<void> {
    const q = value.trim();
    sequence += 1;
    const current = sequence;
    searchError = null;
    if (q.length < 2) {
      candidates = [];
      searching = false;
      return;
    }
    searching = true;
    try {
      const response = await fetch(
        `/admin/api/entity-search?type=contributor&q=${encodeURIComponent(q)}&limit=10`
      );
      if (!response.ok) throw new Error(`the search failed (${response.status})`);
      const body = (await response.json()) as AdminEntitySearchResponse;
      if (current !== sequence) return;
      candidates = body.items.filter((item) => item.id !== data.source.id);
    } catch (error) {
      if (current !== sequence) return;
      searchError = error instanceof Error ? error.message : 'the search failed';
      candidates = [];
    } finally {
      if (current === sequence) searching = false;
    }
  }

  function onQueryInput(event: Event): void {
    query = valueOf(event);
    clearTimeout(timer);
    timer = setTimeout(() => void search(query), 200);
  }
</script>

<main class="admin-main">
  <div class="admin-content wa-stack wa-gap-l merge-shell">
    <div class="merge-heading">
      <div class="wa-stack wa-gap-2xs">
        <a class="admin-small" href="/admin#contributors">← Back to catalog curation</a>
        <a class="admin-small" href={`/admin/contributor/${data.source.id}/edit`}>
          ← Back to this contributor's editor
        </a>
        <h1>Merge contributor</h1>
        <span class="muted admin-wrap">{data.source.name}</span>
      </div>
      <wa-badge variant="warning">Deletes one row</wa-badge>
    </div>

    {#if form?.message}
      <wa-callout variant="danger">{form.message}</wa-callout>
    {/if}
    {#if data.targetError}
      <wa-callout variant="danger">{data.targetError}</wa-callout>
    {/if}

    <wa-callout variant="neutral">
      <div class="wa-stack wa-gap-2xs">
        <strong>What a merge does</strong>
        <ul class="merge-notes">
          <li>The survivor keeps its row id, at-URI, name and creation date.</li>
          <li>
            The absorbed row's blank-filling fields — biography, inverted name, image URL,
            born and died — and any identifier it has are copied onto the survivor only
            where the survivor's own value is empty.
          </li>
          <li>
            Every edition that credits the absorbed row is repointed at the survivor and
            republished. A credit with the same role the survivor already holds on that
            edition is dropped instead of crediting the same person twice.
          </li>
          <li>
            The absorbed row is deleted, and its record delete is queued when it has an
            at-URI. This cannot be undone.
          </li>
        </ul>
      </div>
    </wa-callout>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">1. Choose the survivor</h2>
      <div class="wa-stack wa-gap-m">
        <wa-input
          label="Search catalog contributors"
          placeholder="name or identifier"
          value={query}
          oninput={onQueryInput}
        ></wa-input>
        {#if searching}
          <span class="muted admin-small">Searching…</span>
        {/if}
        {#if searchError}
          <span class="merge-error">{searchError}</span>
        {/if}
        {#if candidates.length > 0}
          <ul class="candidate-list">
            {#each candidates as candidate (candidate.id)}
              <li>
                <a class="candidate" href={`?into=${candidate.id}`}>
                  <span class="candidate-name">{candidate.name}</span>
                  <span class="muted admin-small admin-wrap">
                    id {candidate.id} · {identifiersOf(candidate)}
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        {:else if query.trim().length >= 2 && !searching && !searchError}
          <span class="muted admin-small">No other contributor matches that search.</span>
        {/if}

        <form method="GET" class="merge-fallback">
          <wa-input
            name="into"
            label="…or open a survivor by id or at-URI"
            value={data.into}
            placeholder="12345"
          ></wa-input>
          <wa-button type="submit" size="small" appearance="outlined">
            Preview merge
          </wa-button>
        </form>
      </div>
    </wa-card>

    {#if data.target && data.plan}
      <wa-card with-header appearance="outlined">
        <h2 slot="header">2. Confirm and merge</h2>
        <div class="wa-stack wa-gap-m">
          <div class="merge-pair">
            <div class="wa-stack wa-gap-2xs merge-side">
              <span class="merge-label">Absorbed (deleted)</span>
              <strong class="admin-wrap">{data.source.name}</strong>
              <span class="muted admin-small admin-wrap">
                {data.source.atUri ?? 'no at-URI'}
              </span>
              <span class="muted admin-small">id {data.source.id}</span>
            </div>
            <span class="merge-arrow" aria-hidden="true">→</span>
            <div class="wa-stack wa-gap-2xs merge-side">
              <span class="merge-label">Survivor</span>
              <strong class="admin-wrap">{data.target.name}</strong>
              <span class="muted admin-small admin-wrap">
                {data.target.atUri ?? 'no at-URI'}
              </span>
              <span class="muted admin-small">id {data.target.id}</span>
            </div>
          </div>

          <dl class="entity-meta">
            <div>
              <dt>Credits repointed</dt>
              <dd>{data.plan.moved}</dd>
            </div>
            <div>
              <dt>Redundant credits dropped</dt>
              <dd>{data.plan.dropped}</dd>
            </div>
            <div>
              <dt>Identifiers added</dt>
              <dd>{data.plan.identifiersAdded}</dd>
            </div>
            <div>
              <dt>Fields filled from absorbed</dt>
              <dd>{data.plan.fields.length === 0 ? 'none' : data.plan.fields.join(', ')}</dd>
            </div>
          </dl>

          {#if data.target.atUri === null}
            <wa-callout variant="warning">
              The survivor has no at-URI yet, so nothing inherits the absorbed row's
              published address. The <code>entities.prepare</code> task mints addresses for
              existing rows; the absorbed row's record is still deleted.
            </wa-callout>
          {/if}

          <form method="POST" action="?/merge" class="merge-actions">
            <input type="hidden" name="target" value={data.target.id} />
            <input type="hidden" name="sourceRevision" value={data.source.revision} />
            <input type="hidden" name="targetRevision" value={data.target.revision} />
            <span class="muted admin-small">
              Both rows must be unchanged since this page loaded; otherwise the merge is
              refused with a 409.
            </span>
            <wa-button type="submit" variant="danger">
              Merge and delete “{data.source.name}”
            </wa-button>
          </form>
        </div>
      </wa-card>
    {/if}
  </div>
</main>

<style>
  .merge-shell {
    padding-block: var(--wa-space-l) var(--wa-space-2xl);
  }

  .merge-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
  }

  .merge-heading h1 {
    margin: 0;
  }

  .merge-notes {
    margin: 0;
    padding-inline-start: var(--wa-space-l);
    display: grid;
    gap: var(--wa-space-2xs);
    font-size: var(--wa-font-size-s);
  }

  .merge-error {
    color: var(--wa-color-danger-border-loud, var(--wa-color-danger-text));
    font-size: var(--wa-font-size-xs);
  }

  .candidate-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--wa-space-2xs);
  }

  .candidate {
    display: grid;
    gap: 2px;
    padding: var(--wa-space-xs) var(--wa-space-s);
    border: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    text-decoration: none;
    color: inherit;
  }

  .candidate:hover,
  .candidate:focus-visible {
    border-color: var(--wa-color-brand-border-loud, var(--wa-color-brand-fill-loud));
    background: var(--wa-color-surface-lowered);
  }

  .candidate-name {
    font-weight: var(--wa-font-weight-semibold);
  }

  .merge-fallback {
    display: grid;
    grid-template-columns: minmax(14rem, 1fr) auto;
    gap: var(--wa-space-s);
    align-items: end;
  }

  .merge-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--wa-space-m);
    align-items: center;
  }

  .merge-side {
    padding: var(--wa-space-s);
    border: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
  }

  .merge-label {
    color: var(--wa-color-text-quiet);
    font-size: var(--wa-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .merge-arrow {
    font-size: var(--wa-font-size-xl);
    color: var(--wa-color-text-quiet);
  }

  .merge-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
  }

  @media (max-width: 40rem) {
    .merge-fallback,
    .merge-pair {
      grid-template-columns: minmax(0, 1fr);
    }

    .merge-arrow {
      display: none;
    }
  }
</style>
