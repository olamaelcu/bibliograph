<script lang="ts">
  import {
    MERGE_FIELDS,
    PROVIDERS,
    identifierText,
    type AdminEdition,
    type Candidate,
    type IngestResponse,
    type LinkMode,
    type MergeField,
    type MergeRequest,
    type MergeResponse,
    type Provider,
    type ProviderSearchResponse
  } from '$lib/admin/types';

  const PROVIDER_LABELS: Record<Provider, string> = {
    googlebooks: 'Google Books',
    isbndb: 'ISBNdb',
    goodreads: 'Goodreads'
  };

  // ── Provider search and ingest ────────────────────────────────────────────
  let provider = $state<Provider>('googlebooks');
  let query = $state('');
  let candidates = $state<Candidate[]>([]);
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let ingestStatus = $state<Record<string, 'pending' | 'done'>>({});
  let lastIngest = $state<(IngestResponse & { title: string }) | null>(null);

  function valueOf(event: Event): string {
    const target = event.currentTarget as EventTarget & { value?: unknown };
    return typeof target.value === 'string' ? target.value : '';
  }

  function checkedOf(event: Event): boolean {
    const target = event.currentTarget as EventTarget & { checked?: unknown };
    return target.checked === true;
  }

  function candidateKey(candidate: Candidate): string {
    return candidate.identifiers.map(identifierText).join('|');
  }

  async function responseError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    } catch {
      // Fall through to the status text.
    }
    return `Request failed (${response.status})`;
  }

  async function runProviderSearch() {
    searchError = null;
    lastIngest = null;
    if (query.trim() === '') {
      searchError = 'Enter a title, author or ISBN.';
      return;
    }
    searching = true;
    try {
      const response = await fetch('/admin/api/provider-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, query })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ProviderSearchResponse;
      candidates = Array.isArray(body.candidates) ? body.candidates : [];
      ingestStatus = {};
      if (candidates.length === 0) searchError = 'That provider returned no results.';
    } catch (error) {
      searchError = error instanceof Error ? error.message : 'The search failed.';
      candidates = [];
    } finally {
      searching = false;
    }
  }

  async function ingestCandidate(candidate: Candidate) {
    const key = candidateKey(candidate);
    ingestStatus = { ...ingestStatus, [key]: 'pending' };
    searchError = null;
    try {
      const response = await fetch('/admin/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidate })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as IngestResponse;
      ingestStatus = { ...ingestStatus, [key]: 'done' };
      lastIngest = { ...body, title: candidate.title };
    } catch (error) {
      ingestStatus = { ...ingestStatus };
      delete ingestStatus[key];
      searchError = error instanceof Error ? error.message : 'Ingestion failed.';
    }
  }

  // ── Edition merge ─────────────────────────────────────────────────────────
  let mergeQuery = $state('');
  let mergeResults = $state<AdminEdition[]>([]);
  let selectedRecords = $state<Record<string, AdminEdition>>({});
  let selectedUris = $state<string[]>([]);
  let baseUri = $state('');
  let fieldSources = $state<Partial<Record<MergeField, string>>>({});
  let contributorsMode = $state<LinkMode>('union');
  let publishersMode = $state<LinkMode>('union');
  let contributorsSource = $state('');
  let publishersSource = $state('');
  let mergeSearching = $state(false);
  let mergeError = $state<string | null>(null);
  let mergeNotice = $state<string | null>(null);
  let merging = $state(false);
  let mergeResult = $state<MergeResponse | null>(null);
  let editionTimer: ReturnType<typeof setTimeout> | undefined;
  let editionSequence = 0;

  const selected = $derived(
    selectedUris
      .map((uri) => selectedRecords[uri])
      .filter((record): record is AdminEdition => record !== undefined)
  );

  function chooseBase(uri: string) {
    baseUri = uri;
    fieldSources = {};
    contributorsSource = uri;
    publishersSource = uri;
  }

  function toggleSelection(record: AdminEdition, checked: boolean) {
    if (checked) {
      selectedRecords = { ...selectedRecords, [record.uri]: record };
      if (!selectedUris.includes(record.uri)) selectedUris = [...selectedUris, record.uri];
      if (baseUri === '') chooseBase(record.uri);
      return;
    }

    const next = { ...selectedRecords };
    delete next[record.uri];
    selectedRecords = next;
    selectedUris = selectedUris.filter((uri) => uri !== record.uri);
    if (baseUri === record.uri) chooseBase(selectedUris[0] ?? '');
  }

  function sourceFor(field: MergeField): string {
    const chosen = fieldSources[field];
    return chosen && selectedRecords[chosen] ? chosen : baseUri;
  }

  function setFieldSource(field: MergeField, uri: string) {
    fieldSources = { ...fieldSources, [field]: uri };
  }

  function setLinkMode(which: 'contributors' | 'publishers', mode: LinkMode) {
    if (which === 'contributors') {
      contributorsMode = mode;
      if (mode === 'source' && !selectedRecords[contributorsSource]) contributorsSource = baseUri;
    } else {
      publishersMode = mode;
      if (mode === 'source' && !selectedRecords[publishersSource]) publishersSource = baseUri;
    }
  }

  function displayField(record: AdminEdition | undefined, field: MergeField): string {
    if (!record) return '—';
    const value = record[field];
    if (value === null || value === undefined || value === '') return '— (empty)';
    if (field === 'series' && typeof value === 'object') {
      const series = value as { name: string; position?: string };
      return series.position ? `${series.name} #${series.position}` : series.name;
    }
    return String(value);
  }

  function shortRecord(record: AdminEdition): string {
    return `${record.title} · ${record.rkey}`;
  }

  function isoDate(value: string): string {
    return `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  function unionIdentifiers(records: AdminEdition[]): string[] {
    const seen = new Set<string>();
    const identifiers: string[] = [];
    for (const record of records) {
      for (const identifier of record.identifiers) {
        const text = identifierText(identifier);
        if (seen.has(text)) continue;
        seen.add(text);
        identifiers.push(text);
      }
    }
    return identifiers;
  }

  const fieldPreview = $derived.by(() =>
    MERGE_FIELDS.map(({ key, label }) => {
      const uri = sourceFor(key);
      return {
        key,
        label,
        uri,
        value: displayField(selectedRecords[uri], key)
      };
    })
  );

  const previewContributors = $derived.by(() => {
    if (contributorsMode === 'union') {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const record of selected) {
        for (const contributor of record.contributors) {
          const text = `${contributor.name} (${contributor.role})`;
          if (seen.has(text)) continue;
          seen.add(text);
          names.push(text);
        }
      }
      return names;
    }
    return (selectedRecords[contributorsSource]?.contributors ?? []).map(
      (contributor) => `${contributor.name} (${contributor.role})`
    );
  });

  const previewPublishers = $derived.by(() => {
    if (publishersMode === 'union') {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const record of selected) {
        for (const publisher of record.publishers) {
          if (seen.has(publisher.name)) continue;
          seen.add(publisher.name);
          names.push(publisher.name);
        }
      }
      return names;
    }
    return (selectedRecords[publishersSource]?.publishers ?? []).map((publisher) => publisher.name);
  });

  async function runEditionSearch() {
    mergeError = null;
    mergeNotice = null;
    const q = mergeQuery.trim();
    if (q === '') {
      mergeResults = [];
      return;
    }
    const sequence = ++editionSequence;
    mergeSearching = true;
    try {
      const response = await fetch(`/admin/api/editions?q=${encodeURIComponent(q)}&limit=20`, {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as { items?: AdminEdition[] };
      if (sequence !== editionSequence) return;
      mergeResults = Array.isArray(body.items) ? body.items : [];
      // Keep selected records current when they reappear in a result.
      if (mergeResults.some((record) => selectedRecords[record.uri])) {
        const next = { ...selectedRecords };
        for (const record of mergeResults) {
          if (next[record.uri]) next[record.uri] = record;
        }
        selectedRecords = next;
      }
    } catch (error) {
      if (sequence !== editionSequence) return;
      mergeError = error instanceof Error ? error.message : 'The local search failed.';
      mergeResults = [];
    } finally {
      if (sequence === editionSequence) mergeSearching = false;
    }
  }

  function onMergeQueryInput(value: string) {
    mergeQuery = value;
    if (editionTimer) clearTimeout(editionTimer);
    editionTimer = setTimeout(() => void runEditionSearch(), 250);
  }

  async function findInMerge(value: string) {
    mergeQuery = value;
    if (editionTimer) clearTimeout(editionTimer);
    await runEditionSearch();
    document.getElementById('merge')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function runMerge() {
    mergeError = null;
    mergeNotice = null;
    mergeResult = null;
    if (selectedUris.length < 2) {
      mergeError = 'Select at least two editions to merge.';
      return;
    }
    if (!baseUri) {
      mergeError = 'Choose the base record that keeps its URI.';
      return;
    }

    const sources: Partial<Record<MergeField, string>> = {};
    for (const { key } of MERGE_FIELDS) sources[key] = sourceFor(key);
    const request: MergeRequest = {
      base: baseUri,
      others: selectedUris.filter((uri) => uri !== baseUri),
      sources,
      contributors:
        contributorsMode === 'union'
          ? { mode: 'union' }
          : { mode: 'source', source: contributorsSource || baseUri },
      publishers:
        publishersMode === 'union'
          ? { mode: 'union' }
          : { mode: 'source', source: publishersSource || baseUri }
    };

    merging = true;
    try {
      const response = await fetch('/admin/api/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as MergeResponse;
      mergeResult = result;

      const deleted = new Set(result.deleted);
      const nextRecords = { ...selectedRecords };
      for (const uri of result.deleted) delete nextRecords[uri];
      selectedRecords = nextRecords;
      selectedUris = selectedUris.filter((uri) => !deleted.has(uri));
      mergeResults = mergeResults.filter((record) => !deleted.has(record.uri));
      if (!selectedUris.includes(baseUri)) chooseBase(selectedUris[0] ?? '');
      mergeNotice = `Merged ${result.deleted.length + 1} editions.`;
    } catch (error) {
      mergeError = error instanceof Error ? error.message : 'The merge failed.';
    } finally {
      merging = false;
    }
  }
</script>

<main class="admin-main">
  <section class="section" id="provider">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h1>Catalog curation</h1>
        <p class="lede">
          Search a catalog provider and ingest one result, then reconcile duplicate edition records
          in the local catalog.
        </p>
      </div>

      <wa-card with-header appearance="outlined">
        <h2 slot="header">1 · Provider search and ingest</h2>
        <div class="wa-stack wa-gap-m">
          <div class="admin-form-grid">
            <div class="field">
              <span class="field-label">Provider</span>
              <wa-select
                aria-label="Provider"
                value={provider}
                onchange={(event: Event) => (provider = valueOf(event) as Provider)}
              >
                {#each PROVIDERS as value (value)}
                  <wa-option value={value}>{PROVIDER_LABELS[value]}</wa-option>
                {/each}
              </wa-select>
            </div>
            <div class="field field-grow">
              <span class="field-label">Query or ISBN</span>
              <wa-input
                aria-label="Query or ISBN"
                role="textbox"
                tabindex="0"
                value={query}
                placeholder="Title, author or ISBN-10/ISBN-13"
                oninput={(event: Event) => (query = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runProviderSearch();
                  }
                }}
              ></wa-input>
            </div>
            <div class="admin-form-action">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button variant="brand" disabled={searching} onclick={() => void runProviderSearch()}>
                {searching ? 'Searching…' : 'Search'}
              </wa-button>
            </div>
          </div>

          {#if searchError}
            <wa-callout variant="danger">{searchError}</wa-callout>
          {/if}

          {#if lastIngest}
            <wa-callout variant="success">
              <div class="wa-stack wa-gap-2xs">
                <strong>
                  {lastIngest.created ? 'Ingested' : 'Already in the catalog'}:
                  {lastIngest.title}
                </strong>
                <code class="admin-wrap">{lastIngest.uri}</code>
                <div class="wa-cluster wa-gap-s">
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button size="small" onclick={() => void findInMerge(lastIngest!.title)}>
                    Find in merge
                  </wa-button>
                </div>
              </div>
            </wa-callout>
          {/if}

          {#if candidates.length > 0}
            <div class="admin-results">
              {#each candidates as candidate, index (candidateKey(candidate) + index)}
                <wa-card appearance="outlined" class="admin-result">
                  <div class="admin-result-row">
                    {#if candidate.coverUrl}
                      <img
                        class="admin-cover"
                        src={candidate.coverUrl}
                        alt=""
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    {/if}
                    <div class="wa-stack wa-gap-2xs admin-result-body">
                      <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                        <strong>{candidate.title}</strong>
                        {#if candidate.publishedDate}
                          <span class="muted">{candidate.publishedDate}</span>
                        {/if}
                        {#if candidate.format}
                          <span class="muted">{candidate.format}</span>
                        {/if}
                      </div>
                      {#if candidate.contributors?.length}
                        <span class="muted">
                          {candidate.contributors.map((contributor) => contributor.name).join(', ')}
                        </span>
                      {/if}
                      <div class="wa-cluster wa-gap-2xs">
                        {#each candidate.identifiers as identifier (identifierText(identifier))}
                          <wa-tag size="small" variant="neutral">
                            {identifierText(identifier)}
                          </wa-tag>
                        {/each}
                      </div>
                      {#if candidate.coverUrl}
                        <a class="admin-small" href={candidate.coverUrl} target="_blank" rel="noreferrer">
                          {candidate.coverUrl}
                        </a>
                      {/if}
                      <div class="wa-cluster wa-gap-s">
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                        <wa-button
                          size="small"
                          variant={ingestStatus[candidateKey(candidate)] === 'done'
                            ? 'success'
                            : 'brand'}
                          disabled={ingestStatus[candidateKey(candidate)] === 'pending' ||
                            ingestStatus[candidateKey(candidate)] === 'done'}
                          onclick={() => void ingestCandidate(candidate)}
                        >
                          {ingestStatus[candidateKey(candidate)] === 'pending'
                            ? 'Ingesting…'
                            : ingestStatus[candidateKey(candidate)] === 'done'
                              ? 'Ingested'
                              : 'Ingest'}
                        </wa-button>
                      </div>
                    </div>
                  </div>
                </wa-card>
              {/each}
            </div>
          {/if}
        </div>
      </wa-card>
    </div>
  </section>

  <section class="section" id="merge">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h2>2 · Merge edition records</h2>
        <p class="muted">
          Find editions by title or identifier, select two or more, then choose the base record and
          which record supplies each field.
        </p>
      </div>

      <wa-card with-header appearance="outlined">
        <h3 slot="header">Find local editions</h3>
        <div class="wa-stack wa-gap-m">
          <div class="admin-form-grid">
            <div class="field field-grow">
              <span class="field-label">Title or identifier</span>
              <wa-input
                aria-label="Title or identifier"
                role="textbox"
                tabindex="0"
                value={mergeQuery}
                placeholder="Title, at-URI, ISBN or issuer:value"
                oninput={(event: Event) => onMergeQueryInput(valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runEditionSearch();
                  }
                }}
              ></wa-input>
            </div>
            <div class="admin-form-action">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button disabled={mergeSearching} onclick={() => void runEditionSearch()}>
                {mergeSearching ? 'Searching…' : 'Search catalog'}
              </wa-button>
            </div>
          </div>

          {#if mergeError}
            <wa-callout variant="danger">{mergeError}</wa-callout>
          {/if}
          {#if mergeNotice}
            <wa-callout variant="success">{mergeNotice}</wa-callout>
          {/if}

          {#if mergeResults.length > 0}
            <div class="admin-results">
              {#each mergeResults as record (record.uri)}
                <wa-card appearance="outlined" class="admin-result">
                  <div class="admin-result-row admin-result-select">
                    <wa-checkbox
                      checked={selectedUris.includes(record.uri)}
                      aria-label={`Select ${record.title}`}
                      onchange={(event: Event) => toggleSelection(record, checkedOf(event))}
                    ></wa-checkbox>
                    <div class="wa-stack wa-gap-2xs admin-result-body">
                      <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                        <strong>{record.title}</strong>
                        {#if selectedUris.includes(record.uri)}
                          <wa-badge variant="brand">selected</wa-badge>
                        {/if}
                      </div>
                      <span class="muted">
                        {record.contributors.map((contributor) => contributor.name).join(', ') ||
                          'No contributors'}
                      </span>
                      <div class="wa-cluster wa-gap-2xs">
                        {#each record.identifiers as identifier (identifierText(identifier))}
                          <wa-tag size="small" variant="neutral">
                            {identifierText(identifier)}
                          </wa-tag>
                        {/each}
                      </div>
                      <span class="muted admin-small admin-wrap">
                        {record.uri}<br />
                        indexed {isoDate(record.indexedAt)} · updated {isoDate(record.updatedAt)}
                      </span>
                    </div>
                  </div>
                </wa-card>
              {/each}
            </div>
          {:else if mergeQuery.trim() !== '' && !mergeSearching}
            <p class="muted">No local editions matched.</p>
          {/if}
        </div>
      </wa-card>

      {#if selected.length > 0}
        <wa-card with-header appearance="outlined">
          <h3 slot="header">Selection and field sources</h3>
          <div class="wa-stack wa-gap-m">
            <div class="field">
              <span class="field-label">Final form (base record, keeps its URI)</span>
              <wa-select
                aria-label="Final form base record"
                value={baseUri}
                onchange={(event: Event) => chooseBase(valueOf(event))}
              >
                {#each selected as record (record.uri)}
                  <wa-option value={record.uri}>{shortRecord(record)}</wa-option>
                {/each}
              </wa-select>
            </div>

            <div class="admin-fields">
              {#each fieldPreview as field (field.key)}
                <div class="admin-field-row">
                  <span class="admin-field-label">{field.label}</span>
                  <wa-select
                    size="small"
                    value={field.uri}
                    aria-label={`Source for ${field.label}`}
                    onchange={(event: Event) => setFieldSource(field.key, valueOf(event))}
                  >
                    {#each selected as record (record.uri)}
                      <wa-option value={record.uri}>
                        {record.rkey} — {displayField(record, field.key)}
                      </wa-option>
                    {/each}
                  </wa-select>
                  <span class="admin-field-value">{field.value}</span>
                </div>
              {/each}
            </div>

            <div class="admin-link-grid">
              <div class="admin-link-choice">
                <span class="field-label">Contributors</span>
                <wa-select
                  value={contributorsMode}
                  onchange={(event: Event) =>
                    setLinkMode('contributors', valueOf(event) as LinkMode)}
                >
                  <wa-option value="union">Union all selected records</wa-option>
                  <wa-option value="source">From one record</wa-option>
                </wa-select>
                {#if contributorsMode === 'source'}
                  <wa-select
                    value={contributorsSource}
                    onchange={(event: Event) => (contributorsSource = valueOf(event))}
                  >
                    {#each selected as record (record.uri)}
                      <wa-option value={record.uri}>{shortRecord(record)}</wa-option>
                    {/each}
                  </wa-select>
                {/if}
                <span class="muted admin-small">
                  {previewContributors.join(' · ') || 'No contributors'}
                </span>
              </div>

              <div class="admin-link-choice">
                <span class="field-label">Publishers</span>
                <wa-select
                  value={publishersMode}
                  onchange={(event: Event) =>
                    setLinkMode('publishers', valueOf(event) as LinkMode)}
                >
                  <wa-option value="union">Union all selected records</wa-option>
                  <wa-option value="source">From one record</wa-option>
                </wa-select>
                {#if publishersMode === 'source'}
                  <wa-select
                    value={publishersSource}
                    onchange={(event: Event) => (publishersSource = valueOf(event))}
                  >
                    {#each selected as record (record.uri)}
                      <wa-option value={record.uri}>{shortRecord(record)}</wa-option>
                    {/each}
                  </wa-select>
                {/if}
                <span class="muted admin-small">
                  {previewPublishers.join(' · ') || 'No publishers'}
                </span>
              </div>
            </div>
          </div>
        </wa-card>

        <wa-card with-header appearance="outlined">
          <h3 slot="header">Preview final record</h3>
          <div class="wa-stack wa-gap-m">
            <div class="table-scroll">
              <table class="params admin-preview-table">
                <thead>
                  <tr><th>Field</th><th>Source</th><th>Final value</th></tr>
                </thead>
                <tbody>
                  {#each fieldPreview as field (field.key)}
                    <tr>
                      <td>{field.label}</td>
                      <td><code>{selectedRecords[field.uri]?.rkey ?? '—'}</code></td>
                      <td>{field.value}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <div class="admin-preview-links">
              <div>
                <span class="field-label">Identifiers (union)</span>
                <div class="wa-cluster wa-gap-2xs">
                  {#each unionIdentifiers(selected) as identifier (identifier)}
                    <wa-tag size="small" variant="neutral">{identifier}</wa-tag>
                  {:else}
                    <span class="muted">None</span>
                  {/each}
                </div>
              </div>
              <div>
                <span class="field-label">Contributors</span>
                <p class="admin-small">{previewContributors.join(', ') || 'None'}</p>
              </div>
              <div>
                <span class="field-label">Publishers</span>
                <p class="admin-small">{previewPublishers.join(', ') || 'None'}</p>
              </div>
            </div>

            <div class="wa-cluster wa-gap-s">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                variant="brand"
                disabled={merging || selected.length < 2}
                onclick={() => void runMerge()}
              >
                {merging ? 'Merging…' : `Merge ${selected.length} editions`}
              </wa-button>
              <span class="muted admin-small">
                Duplicate records are deleted after the base is rebuilt.
              </span>
            </div>
          </div>
        </wa-card>
      {/if}

      {#if mergeResult}
        <wa-callout variant="success">
          <div class="wa-stack wa-gap-2xs">
            <strong>Merged into the base record.</strong>
            <code class="admin-wrap">{mergeResult.uri}</code>
            <span class="admin-small">
              {mergeResult.identifiers} identifier(s), {mergeResult.contributors} contributor
              link(s), {mergeResult.publishers} publisher link(s).
            </span>
            {#if mergeResult.deleted.length > 0}
              <span class="field-label">Deleted duplicate records</span>
              <ul class="admin-deleted">
                {#each mergeResult.deleted as uri (uri)}
                  <li><code class="admin-wrap">{uri}</code></li>
                {/each}
              </ul>
            {/if}
            <span class="admin-small muted">
              Reader activity records that referenced a deleted URI are not rewritten; only the
              catalog editions and their PDS outbox rows change.
            </span>
          </div>
        </wa-callout>
      {/if}
    </div>
  </section>
</main>
