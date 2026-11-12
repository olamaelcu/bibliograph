<script lang="ts">
  import { untrack } from 'svelte';
  import { parseEditionEdit } from '$lib/admin/edition-edit';
  import {
    identifierText,
    type AdminEntityMatch,
    type AdminEntitySearchResponse,
    type AdminEdition,
    type EditionEditResponse,
    type Identifier
  } from '$lib/admin/types';
  import { normalizeContributorRole } from '$lib/contributor-roles';

  let { data } = $props();
  const initial: AdminEdition = untrack(() => data.edition);

  type IdentifierRow = Identifier & { key: string };
  type ContributorRow = {
    key: string;
    id: number | null;
    name: string;
    role: string;
    ref: string;
    identifiers: IdentifierRow[];
  };
  type PublisherRow = {
    key: string;
    id: number | null;
    name: string;
    identifiers: IdentifierRow[];
  };

  let keySeed = 0;
  function nextKey(prefix: string): string {
    keySeed += 1;
    return `${prefix}-${keySeed}`;
  }
  function identifierRows(values: Identifier[], prefix: string): IdentifierRow[] {
    return values.map((identifier, index) => ({
      ...identifier,
      key: `${prefix}-${index}-${identifier.issuer}`
    }));
  }

  let uri = $state(initial.uri);
  let rkey = $state(initial.rkey);
  let createdAt = $state(initial.createdAt);
  let updatedAt = $state(initial.updatedAt);
  let revision = $state(initial.revision);
  let indexedAt = $state(initial.indexedAt);

  let title = $state(initial.title);
  let subtitle = $state(initial.subtitle ?? '');
  let language = $state(initial.language ?? '');
  let publishedDate = $state(initial.publishedDate ?? '');
  let format = $state(initial.format ?? '');
  let pages = $state(initial.pages === null ? '' : String(initial.pages));
  let durationSeconds = $state(
    initial.durationSeconds === null ? '' : String(initial.durationSeconds)
  );
  let chapters = $state(initial.chapters === null ? '' : String(initial.chapters));
  let seriesName = $state(initial.series?.name ?? '');
  let seriesPosition = $state(initial.series?.position ?? '');
  let seriesDisplay = $state(initial.series?.display ?? '');
  let bookEdition = $state(initial.bookEdition ?? '');
  let description = $state(initial.description ?? '');
  let coverUrl = $state(initial.coverUrl ?? '');

  let identifiers = $state<IdentifierRow[]>(
    identifierRows(initial.identifiers, 'edition-identifier')
  );
  let contributors = $state<ContributorRow[]>(
    initial.contributors.map((contributor) => ({
      key: nextKey('contributor'),
      id: contributor.id,
      name: contributor.name,
      role: contributor.role,
      ref: contributor.ref ?? '',
      identifiers: identifierRows(contributor.identifiers, `contributor-${contributor.id}`)
    }))
  );
  let publishers = $state<PublisherRow[]>(
    initial.publishers.map((publisher) => ({
      key: nextKey('publisher'),
      id: publisher.id,
      name: publisher.name,
      identifiers: identifierRows(publisher.identifiers, `publisher-${publisher.id}`)
    }))
  );

  let baseline = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let attempted = $state(false);

  function valueOf(event: Event): string {
    const target = event.currentTarget as EventTarget & { value?: unknown };
    return typeof target.value === 'string' ? target.value : '';
  }

  function valueOrNull(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  function intOrNull(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function usedIdentifiers(rows: IdentifierRow[]): Identifier[] {
    return rows
      .filter((row) => row.issuer.trim() !== '' || row.value.trim() !== '')
      .map((row) => ({ issuer: row.issuer.trim(), value: row.value.trim() }));
  }

  function buildPayload() {
    const series =
      seriesName.trim() === ''
        ? null
        : {
            name: seriesName.trim(),
            ...(seriesPosition.trim() !== '' ? { position: seriesPosition.trim() } : {}),
            ...(seriesDisplay.trim() !== '' ? { display: seriesDisplay.trim() } : {})
          };
    return {
      title,
      subtitle: valueOrNull(subtitle),
      language: valueOrNull(language),
      publishedDate: valueOrNull(publishedDate),
      format: valueOrNull(format),
      pages: intOrNull(pages),
      durationSeconds: intOrNull(durationSeconds),
      chapters: intOrNull(chapters),
      series,
      bookEdition: valueOrNull(bookEdition),
      description: valueOrNull(description),
      coverUrl: valueOrNull(coverUrl),
      identifiers: usedIdentifiers(identifiers),
      contributors: contributors.map((contributor) =>
        contributor.id !== null
          ? {
              id: contributor.id,
              role: contributor.role,
              ref: valueOrNull(contributor.ref)
            }
          : {
              name: contributor.name.trim(),
              role: contributor.role,
              ref: valueOrNull(contributor.ref),
              identifiers: usedIdentifiers(contributor.identifiers)
            }
      ),
      publishers: publishers.map((publisher) =>
        publisher.id !== null
          ? { id: publisher.id }
          : {
              name: publisher.name.trim(),
              identifiers: usedIdentifiers(publisher.identifiers)
            }
      ),
      expectedRevision: revision
    };
  }

  const issues = $derived.by(() => parseEditionEdit(buildPayload()).errors);
  const dirty = $derived(JSON.stringify(buildPayload()) !== baseline);
  const valid = $derived(issues.length === 0);

  function fieldError(path: string): string | null {
    return issues.find((issue) => issue.path === path)?.message ?? null;
  }

  function sectionErrors(prefix: string): string[] {
    return issues
      .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
      .map((issue) => (issue.path === prefix ? issue.message : `${issue.path}: ${issue.message}`));
  }

  const coverPreview = $derived.by(() => {
    const value = coverUrl.trim();
    if (value === '') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.toString();
    } catch {
      return null;
    }
  });

  function addIdentifier(rows: IdentifierRow[]) {
    rows.push({ key: nextKey('identifier'), issuer: '', value: '' });
  }

  function removeIdentifier(rows: IdentifierRow[], key: string) {
    const index = rows.findIndex((row) => row.key === key);
    if (index >= 0) rows.splice(index, 1);
  }

  function moveContributor(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= contributors.length) return;
    const [row] = contributors.splice(index, 1);
    if (row) contributors.splice(target, 0, row);
  }

  function removeContributor(index: number) {
    contributors.splice(index, 1);
  }

  function movePublisher(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= publishers.length) return;
    const [row] = publishers.splice(index, 1);
    if (row) publishers.splice(target, 0, row);
  }

  function removePublisher(index: number) {
    publishers.splice(index, 1);
  }

  // ── Existing contributor/publisher picker ─────────────────────────────────
  let contributorQuery = $state('');
  let contributorMatches = $state<AdminEntityMatch[]>([]);
  let contributorSearching = $state(false);
  let contributorSearchError = $state<string | null>(null);
  let newContributorName = $state('');
  let newContributorIdentifiers = $state<IdentifierRow[]>([
    { key: nextKey('new-contributor-identifier'), issuer: '', value: '' }
  ]);

  let publisherQuery = $state('');
  let publisherMatches = $state<AdminEntityMatch[]>([]);
  let publisherSearching = $state(false);
  let publisherSearchError = $state<string | null>(null);
  let newPublisherName = $state('');
  let newPublisherIdentifiers = $state<IdentifierRow[]>([
    { key: nextKey('new-publisher-identifier'), issuer: '', value: '' }
  ]);

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

  async function searchEntities(
    type: 'contributor' | 'publisher',
    value: string
  ): Promise<AdminEntityMatch[]> {
    const response = await fetch(
      `/admin/api/entity-search?type=${type}&q=${encodeURIComponent(value)}&limit=20`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(await responseError(response));
    const body = (await response.json()) as AdminEntitySearchResponse;
    return Array.isArray(body.items) ? body.items : [];
  }

  async function searchContributors() {
    contributorSearchError = null;
    const query = contributorQuery.trim();
    if (query === '') {
      contributorSearchError = 'Enter a name or identifier.';
      return;
    }
    contributorSearching = true;
    try {
      contributorMatches = await searchEntities('contributor', query);
      if (contributorMatches.length === 0) {
        contributorSearchError = 'No local contributor matched; create one below.';
      }
    } catch (error) {
      contributorMatches = [];
      contributorSearchError = error instanceof Error ? error.message : 'The search failed.';
    } finally {
      contributorSearching = false;
    }
  }

  async function searchPublishers() {
    publisherSearchError = null;
    const query = publisherQuery.trim();
    if (query === '') {
      publisherSearchError = 'Enter a name or identifier.';
      return;
    }
    publisherSearching = true;
    try {
      publisherMatches = await searchEntities('publisher', query);
      if (publisherMatches.length === 0) {
        publisherSearchError = 'No local publisher matched; create one below.';
      }
    } catch (error) {
      publisherMatches = [];
      publisherSearchError = error instanceof Error ? error.message : 'The search failed.';
    } finally {
      publisherSearching = false;
    }
  }

  function addExistingContributor(match: AdminEntityMatch) {
    if (contributors.some((contributor) => contributor.id === match.id)) {
      contributorSearchError = 'That contributor is already credited.';
      return;
    }
    contributors.push({
      key: nextKey('contributor'),
      id: match.id,
      name: match.name,
      role: 'A01',
      ref: '',
      identifiers: identifierRows(match.identifiers, `contributor-${match.id}`)
    });
    contributorSearchError = null;
  }

  function addNewContributor() {
    const name = newContributorName.trim();
    if (name === '') {
      contributorSearchError = 'Enter a display name for the new contributor.';
      return;
    }
    contributors.push({
      key: nextKey('contributor'),
      id: null,
      name,
      role: 'A01',
      ref: '',
      identifiers: usedIdentifiers(newContributorIdentifiers).map((identifier) => ({
        ...identifier,
        key: nextKey('contributor-identifier')
      }))
    });
    newContributorName = '';
    newContributorIdentifiers = [
      { key: nextKey('new-contributor-identifier'), issuer: '', value: '' }
    ];
    contributorSearchError = null;
  }

  function addExistingPublisher(match: AdminEntityMatch) {
    if (publishers.some((publisher) => publisher.id === match.id)) {
      publisherSearchError = 'That publisher is already linked.';
      return;
    }
    publishers.push({
      key: nextKey('publisher'),
      id: match.id,
      name: match.name,
      identifiers: identifierRows(match.identifiers, `publisher-${match.id}`)
    });
    publisherSearchError = null;
  }

  function addNewPublisher() {
    const name = newPublisherName.trim();
    if (name === '') {
      publisherSearchError = 'Enter a name for the new publisher.';
      return;
    }
    publishers.push({
      key: nextKey('publisher'),
      id: null,
      name,
      identifiers: usedIdentifiers(newPublisherIdentifiers).map((identifier) => ({
        ...identifier,
        key: nextKey('publisher-identifier')
      }))
    });
    newPublisherName = '';
    newPublisherIdentifiers = [
      { key: nextKey('new-publisher-identifier'), issuer: '', value: '' }
    ];
    publisherSearchError = null;
  }

  function applyEdition(edition: AdminEdition) {
    uri = edition.uri;
    rkey = edition.rkey;
    createdAt = edition.createdAt;
    updatedAt = edition.updatedAt;
    indexedAt = edition.indexedAt;
    revision = edition.revision;
    title = edition.title;
    subtitle = edition.subtitle ?? '';
    language = edition.language ?? '';
    publishedDate = edition.publishedDate ?? '';
    format = edition.format ?? '';
    pages = edition.pages === null ? '' : String(edition.pages);
    durationSeconds =
      edition.durationSeconds === null ? '' : String(edition.durationSeconds);
    chapters = edition.chapters === null ? '' : String(edition.chapters);
    seriesName = edition.series?.name ?? '';
    seriesPosition = edition.series?.position ?? '';
    seriesDisplay = edition.series?.display ?? '';
    bookEdition = edition.bookEdition ?? '';
    description = edition.description ?? '';
    coverUrl = edition.coverUrl ?? '';
    identifiers = identifierRows(edition.identifiers, 'edition-identifier');
    contributors = edition.contributors.map((contributor) => ({
      key: nextKey('contributor'),
      id: contributor.id,
      name: contributor.name,
      role: contributor.role,
      ref: contributor.ref ?? '',
      identifiers: identifierRows(contributor.identifiers, `contributor-${contributor.id}`)
    }));
    publishers = edition.publishers.map((publisher) => ({
      key: nextKey('publisher'),
      id: publisher.id,
      name: publisher.name,
      identifiers: identifierRows(publisher.identifiers, `publisher-${publisher.id}`)
    }));
    baseline = JSON.stringify(buildPayload());
  }

  async function save() {
    attempted = true;
    saveError = null;
    notice = null;
    if (!valid) {
      saveError = 'Fix the highlighted fields before saving.';
      return;
    }
    if (!dirty) return;
    saving = true;
    try {
      const response = await fetch(
        `/admin/api/editions/${encodeURIComponent(rkey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildPayload())
        }
      );
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as EditionEditResponse;
      applyEdition(body.edition);
      notice =
        'Saved. The catalog triggers queued the edition and any new contributor or publisher records for publication.';
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'The save failed.';
    } finally {
      saving = false;
    }
  }

  baseline = JSON.stringify(buildPayload());

  // A client-side navigation between two editor URLs reuses this component;
  // reset only when the loaded edition itself changes, never on invalidate.
  $effect(() => {
    if (data.edition.uri !== uri) applyEdition(data.edition);
  });

</script>

{#snippet identifierEditor(rows: IdentifierRow[], label: string)}
  <div class="identifier-list">
    {#each rows as row (row.key)}
      <div class="identifier-row">
        <wa-input
          aria-label={`${label} issuer`}
          value={row.issuer}
          placeholder="issuer (e.g. isbn13)"
          oninput={(event: Event) => (row.issuer = valueOf(event))}
        ></wa-input>
        <wa-input
          aria-label={`${label} value`}
          value={row.value}
          placeholder="value"
          oninput={(event: Event) => (row.value = valueOf(event))}
        ></wa-input>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <wa-button
          size="small"
          appearance="plain"
          aria-label={`Remove ${label} ${row.issuer || row.value || 'row'}`}
          onclick={() => removeIdentifier(rows, row.key)}
        >
          Remove
        </wa-button>
      </div>
    {/each}
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <wa-button size="small" appearance="outlined" onclick={() => addIdentifier(rows)}>
    Add identifier
  </wa-button>
{/snippet}

<main class="admin-main">
  <div class="admin-content wa-stack wa-gap-l editor-shell">
    <div class="editor-heading">
      <div class="wa-stack wa-gap-2xs">
        <a class="admin-small" href="/admin#merge">← Back to catalog curation</a>
        <h1>Edit edition</h1>
        <span class="muted admin-wrap">{uri}</span>
        <span class="muted admin-small">
          rkey <code>{rkey}</code> · created {new Date(createdAt).toISOString()} · indexed
          {new Date(indexedAt).toISOString()} · updated {new Date(updatedAt).toISOString()}
        </span>
      </div>
      {#if dirty}
        <wa-badge variant="warning">Unsaved changes</wa-badge>
      {:else}
        <wa-badge variant="neutral">Saved</wa-badge>
      {/if}
    </div>

    {#if saveError}
      <wa-callout variant="danger">{saveError}</wa-callout>
    {/if}
    {#if notice}
      <wa-callout variant="success">{notice}</wa-callout>
    {/if}
    {#if attempted && !valid}
      <wa-callout variant="warning">
        <div class="wa-stack wa-gap-2xs">
          <strong>This record is not ready to save.</strong>
          <ul class="issue-list">
            {#each issues as issue (issue.path + issue.message)}
              <li>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>
            {/each}
          </ul>
        </div>
      </wa-callout>
    {/if}

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Edition fields</h2>
      <div class="wa-stack wa-gap-m">
        <div class="editor-grid">
          <div class="field editor-span-2">
            <span class="field-label">Title</span>
            <wa-input
              aria-label="Title"
              value={title}
              required
              oninput={(event: Event) => (title = valueOf(event))}
            ></wa-input>
            {#if fieldError('title')}
              <span class="field-error">{fieldError('title')}</span>
            {/if}
          </div>
          <div class="field editor-span-2">
            <span class="field-label">Subtitle</span>
            <wa-input
              aria-label="Subtitle"
              value={subtitle}
              oninput={(event: Event) => (subtitle = valueOf(event))}
            ></wa-input>
          </div>
          <div class="field">
            <span class="field-label">Language (BCP 47)</span>
            <wa-input
              aria-label="Language"
              value={language}
              placeholder="en"
              oninput={(event: Event) => (language = valueOf(event))}
            ></wa-input>
            {#if fieldError('language')}
              <span class="field-error">{fieldError('language')}</span>
            {/if}
          </div>
          <div class="field">
            <span class="field-label">Published date</span>
            <wa-input
              aria-label="Published date"
              value={publishedDate}
              placeholder="YYYY, YYYY-MM or YYYY-MM-DD"
              oninput={(event: Event) => (publishedDate = valueOf(event))}
            ></wa-input>
            {#if fieldError('publishedDate')}
              <span class="field-error">{fieldError('publishedDate')}</span>
            {/if}
          </div>
          <div class="field">
            <span class="field-label">Format</span>
            <wa-select
              aria-label="Format"
              value={format}
              onchange={(event: Event) => (format = valueOf(event))}
            >
              <wa-option value="">Unknown</wa-option>
              <wa-option value="physical">Physical</wa-option>
              <wa-option value="ebook">Ebook</wa-option>
              <wa-option value="audio">Audio</wa-option>
            </wa-select>
            {#if fieldError('format')}
              <span class="field-error">{fieldError('format')}</span>
            {/if}
          </div>
          <div class="field">
            <span class="field-label">Book edition</span>
            <wa-input
              aria-label="Book edition"
              value={bookEdition}
              placeholder="2nd revised"
              oninput={(event: Event) => (bookEdition = valueOf(event))}
            ></wa-input>
          </div>
          <div class="field">
            <span class="field-label">Pages</span>
            <wa-input
              aria-label="Pages"
              value={pages}
              inputmode="numeric"
              placeholder="0"
              oninput={(event: Event) => (pages = valueOf(event))}
            ></wa-input>
            {#if fieldError('pages')}
              <span class="field-error">{fieldError('pages')}</span>
            {/if}
          </div>
          <div class="field">
            <span class="field-label">Duration (seconds)</span>
            <wa-input
              aria-label="Duration in seconds"
              value={durationSeconds}
              inputmode="numeric"
              placeholder="0"
              oninput={(event: Event) => (durationSeconds = valueOf(event))}
            ></wa-input>
            {#if fieldError('durationSeconds')}
              <span class="field-error">{fieldError('durationSeconds')}</span>
            {/if}
          </div>
          <div class="field">
            <span class="field-label">Chapters</span>
            <wa-input
              aria-label="Chapters"
              value={chapters}
              inputmode="numeric"
              placeholder="0"
              oninput={(event: Event) => (chapters = valueOf(event))}
            ></wa-input>
            {#if fieldError('chapters')}
              <span class="field-error">{fieldError('chapters')}</span>
            {/if}
          </div>
        </div>

        <div class="editor-grid editor-grid-3">
          <div class="field">
            <span class="field-label">Series name</span>
            <wa-input
              aria-label="Series name"
              value={seriesName}
              oninput={(event: Event) => (seriesName = valueOf(event))}
            ></wa-input>
          </div>
          <div class="field">
            <span class="field-label">Series position</span>
            <wa-input
              aria-label="Series position"
              value={seriesPosition}
              placeholder="1.5"
              oninput={(event: Event) => (seriesPosition = valueOf(event))}
            ></wa-input>
          </div>
          <div class="field">
            <span class="field-label">Series display</span>
            <wa-input
              aria-label="Series display"
              value={seriesDisplay}
              placeholder="Vol. VI"
              oninput={(event: Event) => (seriesDisplay = valueOf(event))}
            ></wa-input>
          </div>
        </div>
        {#if sectionErrors('series').length > 0}
          <span class="field-error">{sectionErrors('series').join(' · ')}</span>
        {/if}

        <div class="field">
          <span class="field-label">Description</span>
          <wa-textarea
            aria-label="Description"
            rows="5"
            value={description}
            oninput={(event: Event) => (description = valueOf(event))}
          ></wa-textarea>
          {#if fieldError('description')}
            <span class="field-error">{fieldError('description')}</span>
          {/if}
        </div>

        <div class="editor-grid">
          <div class="field editor-span-2">
            <span class="field-label">Cover URL (http or https)</span>
            <wa-input
              aria-label="Cover URL"
              value={coverUrl}
              placeholder="https://example.org/cover.jpg"
              oninput={(event: Event) => (coverUrl = valueOf(event))}
            ></wa-input>
            {#if fieldError('coverUrl')}
              <span class="field-error">{fieldError('coverUrl')}</span>
            {/if}
          </div>
          {#if coverPreview}
            <div class="field cover-preview">
              <span class="field-label">Preview</span>
              <img src={coverPreview} alt="" loading="lazy" referrerpolicy="no-referrer" />
            </div>
          {/if}
        </div>
      </div>
    </wa-card>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Identifiers</h2>
      <div class="wa-stack wa-gap-s">
        <p class="muted admin-small">
          At least one identifier is required. Issuer and value are compared exactly; do not
          normalise ISBNs here unless you intend to change the identifier.
        </p>
        {@render identifierEditor(identifiers, 'Edition identifier')}
        {#if sectionErrors('identifiers').length > 0}
          <span class="field-error">{sectionErrors('identifiers').join(' · ')}</span>
        {/if}
      </div>
    </wa-card>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Contributors</h2>
      <div class="wa-stack wa-gap-m">
        <p class="muted admin-small">
          Order is the record order. Role is normalised to ONIX Codelist 17 (legacy names such as
          “editor” map to B01). An existing row keeps its catalog entity; editing its name or
          identifiers here is not allowed.
        </p>

        {#if contributors.length === 0}
          <wa-callout variant="warning">At least one contributor is required.</wa-callout>
        {/if}

        <div class="credit-list">
          {#each contributors as contributor, index (contributor.key)}
            <div class="credit-row">
              <div class="credit-header">
                <div class="wa-stack wa-gap-2xs credit-name">
                  {#if contributor.id === null}
                    <wa-input
                      aria-label={`Contributor ${index + 1} name`}
                      value={contributor.name}
                      placeholder="Display name"
                      oninput={(event: Event) => (contributor.name = valueOf(event))}
                    ></wa-input>
                  {:else}
                    <strong>{contributor.name}</strong>
                    <span class="muted admin-small">catalog row #{contributor.id}</span>
                  {/if}
                </div>
                <div class="wa-cluster wa-gap-2xs">
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Move ${contributor.name} up`}
                    disabled={index === 0}
                    onclick={() => moveContributor(index, -1)}>↑</wa-button
                  >
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Move ${contributor.name} down`}
                    disabled={index === contributors.length - 1}
                    onclick={() => moveContributor(index, 1)}>↓</wa-button
                  >
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Remove ${contributor.name}`}
                    onclick={() => removeContributor(index)}>Remove</wa-button
                  >
                </div>
              </div>

              <div class="credit-fields">
                <div class="field">
                  <span class="field-label">Role</span>
                  <wa-input
                    aria-label={`Role for ${contributor.name}`}
                    value={contributor.role}
                    placeholder="A01"
                    oninput={(event: Event) => (contributor.role = valueOf(event))}
                    onblur={() =>
                      (contributor.role = normalizeContributorRole(contributor.role))}
                  ></wa-input>
                </div>
                <div class="field field-grow">
                  <span class="field-label">Per-edge ref (optional at:// URI)</span>
                  <wa-input
                    aria-label={`Reference for ${contributor.name}`}
                    value={contributor.ref}
                    placeholder="at://did/collection/rkey"
                    oninput={(event: Event) => (contributor.ref = valueOf(event))}
                  ></wa-input>
                </div>
              </div>

              {#if fieldError(`contributors.${index}.name`)}
                <span class="field-error">{fieldError(`contributors.${index}.name`)}</span>
              {/if}
              {#if fieldError(`contributors.${index}.role`)}
                <span class="field-error">{fieldError(`contributors.${index}.role`)}</span>
              {/if}
              {#if fieldError(`contributors.${index}.ref`)}
                <span class="field-error">{fieldError(`contributors.${index}.ref`)}</span>
              {/if}

              {#if contributor.id === null}
                <div class="wa-stack wa-gap-2xs">
                  <span class="field-label">New contributor identifiers</span>
                  {@render identifierEditor(
                    contributor.identifiers,
                    `Contributor ${index + 1} identifier`
                  )}
                </div>
              {:else if contributor.identifiers.length > 0}
                <div class="wa-cluster wa-gap-2xs">
                  {#each contributor.identifiers as identifier (identifierText(identifier))}
                    <wa-tag size="small" variant="neutral">{identifierText(identifier)}</wa-tag>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <div class="picker">
          <div class="wa-stack wa-gap-xs">
            <span class="field-label">Add an existing contributor</span>
            <div class="picker-search">
              <wa-input
                aria-label="Search local contributors"
                role="textbox"
                tabindex="0"
                value={contributorQuery}
                placeholder="Name or identifier"
                oninput={(event: Event) => (contributorQuery = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void searchContributors();
                  }
                }}
              ></wa-input>
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                size="small"
                disabled={contributorSearching}
                onclick={() => void searchContributors()}
              >
                {contributorSearching ? 'Searching…' : 'Search'}
              </wa-button>
            </div>
            {#if contributorSearchError}
              <span class="field-error">{contributorSearchError}</span>
            {/if}
            {#if contributorMatches.length > 0}
              <div class="match-list">
                {#each contributorMatches as match (match.id)}
                  <div class="match-row">
                    <div class="wa-stack wa-gap-2xs">
                      <strong>{match.name}</strong>
                      <span class="muted admin-small">
                        {match.identifiers.length > 0
                          ? match.identifiers.map(identifierText).join(' · ')
                          : 'No identifiers'}
                      </span>
                    </div>
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <wa-button size="small" onclick={() => addExistingContributor(match)}>
                      Add
                    </wa-button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="wa-stack wa-gap-xs">
            <span class="field-label">Create a new contributor</span>
            <wa-input
              aria-label="New contributor display name"
              value={newContributorName}
              placeholder="Display name"
              oninput={(event: Event) => (newContributorName = valueOf(event))}
            ></wa-input>
            {@render identifierEditor(newContributorIdentifiers, 'New contributor identifier')}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <wa-button size="small" appearance="outlined" onclick={addNewContributor}>
              Add new contributor
            </wa-button>
          </div>
        </div>
      </div>
    </wa-card>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Publishers</h2>
      <div class="wa-stack wa-gap-m">
        <p class="muted admin-small">
          The catalog can link several publishers. The published edition record carries the first
          one; order is therefore significant.
        </p>

        <div class="credit-list">
          {#each publishers as publisher, index (publisher.key)}
            <div class="credit-row">
              <div class="credit-header">
                <div class="wa-stack wa-gap-2xs credit-name">
                  {#if publisher.id === null}
                    <wa-input
                      aria-label={`Publisher ${index + 1} name`}
                      value={publisher.name}
                      placeholder="Publisher name"
                      oninput={(event: Event) => (publisher.name = valueOf(event))}
                    ></wa-input>
                  {:else}
                    <strong>{publisher.name}</strong>
                    <span class="muted admin-small">catalog row #{publisher.id}</span>
                  {/if}
                </div>
                <div class="wa-cluster wa-gap-2xs">
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Move ${publisher.name} up`}
                    disabled={index === 0}
                    onclick={() => movePublisher(index, -1)}>↑</wa-button
                  >
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Move ${publisher.name} down`}
                    disabled={index === publishers.length - 1}
                    onclick={() => movePublisher(index, 1)}>↓</wa-button
                  >
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    appearance="plain"
                    aria-label={`Remove ${publisher.name}`}
                    onclick={() => removePublisher(index)}>Remove</wa-button
                  >
                </div>
              </div>

              {#if fieldError(`publishers.${index}.name`)}
                <span class="field-error">{fieldError(`publishers.${index}.name`)}</span>
              {/if}

              {#if publisher.id === null}
                <div class="wa-stack wa-gap-2xs">
                  <span class="field-label">New publisher identifiers</span>
                  {@render identifierEditor(
                    publisher.identifiers,
                    `Publisher ${index + 1} identifier`
                  )}
                </div>
              {:else if publisher.identifiers.length > 0}
                <div class="wa-cluster wa-gap-2xs">
                  {#each publisher.identifiers as identifier (identifierText(identifier))}
                    <wa-tag size="small" variant="neutral">{identifierText(identifier)}</wa-tag>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <div class="picker">
          <div class="wa-stack wa-gap-xs">
            <span class="field-label">Add an existing publisher</span>
            <div class="picker-search">
              <wa-input
                aria-label="Search local publishers"
                role="textbox"
                tabindex="0"
                value={publisherQuery}
                placeholder="Name or identifier"
                oninput={(event: Event) => (publisherQuery = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void searchPublishers();
                  }
                }}
              ></wa-input>
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                size="small"
                disabled={publisherSearching}
                onclick={() => void searchPublishers()}
              >
                {publisherSearching ? 'Searching…' : 'Search'}
              </wa-button>
            </div>
            {#if publisherSearchError}
              <span class="field-error">{publisherSearchError}</span>
            {/if}
            {#if publisherMatches.length > 0}
              <div class="match-list">
                {#each publisherMatches as match (match.id)}
                  <div class="match-row">
                    <div class="wa-stack wa-gap-2xs">
                      <strong>{match.name}</strong>
                      <span class="muted admin-small">
                        {match.identifiers.length > 0
                          ? match.identifiers.map(identifierText).join(' · ')
                          : 'No identifiers'}
                      </span>
                    </div>
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <wa-button size="small" onclick={() => addExistingPublisher(match)}>
                      Add
                    </wa-button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="wa-stack wa-gap-xs">
            <span class="field-label">Create a new publisher</span>
            <wa-input
              aria-label="New publisher name"
              value={newPublisherName}
              placeholder="Publisher name"
              oninput={(event: Event) => (newPublisherName = valueOf(event))}
            ></wa-input>
            {@render identifierEditor(newPublisherIdentifiers, 'New publisher identifier')}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <wa-button size="small" appearance="outlined" onclick={addNewPublisher}>
              Add new publisher
            </wa-button>
          </div>
        </div>
      </div>
    </wa-card>

    <div class="editor-actions">
      <div class="wa-stack wa-gap-2xs">
        <strong>{dirty ? 'Unsaved changes' : 'All changes saved'}</strong>
        <span class="muted admin-small">
          Saving replaces the edition's identifiers, contributor credits and publisher links in one
          transaction; the catalog triggers queue the edition for publication.
        </span>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <wa-button
        variant="brand"
        disabled={saving || !dirty}
        onclick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save edition'}
      </wa-button>
    </div>
  </div>
</main>

<style>
  .editor-shell {
    padding-block: var(--wa-space-l) var(--wa-space-2xl);
  }

  .editor-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
  }

  .editor-heading h1 {
    margin: 0;
  }

  .editor-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--wa-space-m);
  }

  .editor-grid-3 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .editor-span-2 {
    grid-column: span 2;
  }

  .field-error {
    color: var(--wa-color-danger-border-loud, var(--wa-color-danger-text));
    font-size: var(--wa-font-size-xs);
  }

  .issue-list {
    margin: 0;
    padding-inline-start: var(--wa-space-l);
    font-size: var(--wa-font-size-xs);
  }

  .identifier-list {
    display: grid;
    gap: var(--wa-space-2xs);
  }

  .identifier-row {
    display: grid;
    grid-template-columns: minmax(8rem, 0.8fr) minmax(12rem, 1.4fr) auto;
    gap: var(--wa-space-xs);
    align-items: center;
  }

  .credit-list {
    display: grid;
    gap: var(--wa-space-m);
  }

  .credit-row {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-m);
    border: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
  }

  .credit-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--wa-space-s);
    flex-wrap: wrap;
  }

  .credit-name {
    min-width: 0;
  }

  .credit-fields {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
  }

  .credit-fields .field-grow {
    flex: 1 1 18rem;
  }

  .picker {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: var(--wa-space-m);
    padding: var(--wa-space-m);
    border: var(--wa-border-width-s) dashed var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
  }

  .picker-search {
    display: flex;
    gap: var(--wa-space-2xs);
    align-items: center;
  }

  .picker-search wa-input {
    flex: 1;
  }

  .match-list {
    display: grid;
    gap: var(--wa-space-2xs);
  }

  .match-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--wa-space-s);
    padding-block: var(--wa-space-2xs);
    border-bottom: var(--wa-border-width-s) solid var(--wa-color-surface-border);
  }

  .cover-preview img {
    max-width: 8rem;
    height: auto;
    border-radius: var(--wa-border-radius-s);
    box-shadow: var(--wa-shadow-s);
  }

  .editor-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
    padding: var(--wa-space-m);
    border: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
    position: sticky;
    bottom: var(--wa-space-s);
    z-index: 2;
  }

  @media (max-width: 900px) {
    .editor-grid,
    .editor-grid-3 {
      grid-template-columns: minmax(0, 1fr);
    }

    .editor-span-2 {
      grid-column: auto;
    }
  }

  @media (max-width: 640px) {
    .identifier-row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
