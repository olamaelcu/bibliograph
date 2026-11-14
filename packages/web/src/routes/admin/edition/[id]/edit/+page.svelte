<script lang="ts">
  import { untrack } from 'svelte';
  import { parseEditionEdit } from '$lib/admin/edition-edit';
  import {
    identifierText,
    type AdminEntityMatch,
    type AdminEntitySearchResponse,
    type AdminEdition,
    type EditionEditResponse,
    type Identifier,
    type IdentifierInfo,
    type ResolveFormatResponse
  } from '$lib/admin/types';
  import { normalizeContributorRole } from '$lib/contributor-roles';

  let { data } = $props();
  const initial: AdminEdition = untrack(() => data.edition);

  type IdentifierInfoDraft = {
    format: string;
    language: string;
    publishedDate: string;
    pages: string;
    description: string;
  };
  /** `info` is present only on the edition bag: claims exist per edition identifier. */
  type IdentifierRow = Identifier & {
    key: string;
    info?: IdentifierInfoDraft;
    publishers?: PublisherLink[];
    publisherQuery?: string;
    publisherMatches?: AdminEntityMatch[];
    publisherSearchError?: string | null;
    publisherSearching?: boolean;
  };
  const EMPTY_INFO: IdentifierInfoDraft = {
    format: '',
    language: '',
    publishedDate: '',
    pages: '',
    description: ''
  };
  type ContributorRow = {
    key: string;
    id: number | null;
    name: string;
    role: string;
    ref: string;
    identifiers: IdentifierRow[];
  };
  /** One publisher credited by a single identifier row. */
  type PublisherLink = { key: string; id: number | null; name: string };

  let keySeed = 0;
  function nextKey(prefix: string): string {
    keySeed += 1;
    return `${prefix}-${keySeed}`;
  }
  function identifierRows(
    values: Array<
      Identifier & { info?: IdentifierInfo | null; publishers?: Array<{ id: number; name: string }> }
    >,
    prefix: string,
    withClaims = false
  ): IdentifierRow[] {
    return values.map((identifier, index) => ({
      issuer: identifier.issuer,
      value: identifier.value,
      key: `${prefix}-${index}-${identifier.issuer}`,
      ...(withClaims
        ? {
            info: infoDraft(identifier.info),
            publishers: (identifier.publishers ?? []).map((publisher) => ({
              key: `${prefix}-${index}-${publisher.id}`,
              id: publisher.id,
              name: publisher.name
            })),
            publisherQuery: '',
            publisherMatches: [],
            publisherSearchError: null,
            publisherSearching: false
          }
        : {})
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
  let durationSeconds = $state(
    initial.durationSeconds === null ? '' : String(initial.durationSeconds)
  );
  let chapters = $state(initial.chapters === null ? '' : String(initial.chapters));
  let seriesName = $state(initial.series?.name ?? '');
  let seriesPosition = $state(initial.series?.position ?? '');
  let seriesDisplay = $state(initial.series?.display ?? '');
  let bookEdition = $state(initial.bookEdition ?? '');
  let coverUrl = $state(initial.coverUrl ?? '');

  let identifiers = $state<IdentifierRow[]>(
    identifierRows(initial.identifiers, 'edition-identifier', true)
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

  let baseline = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let attempted = $state(false);
  /** Which identifier row's Goodreads lookup is running (one at a time). */
  let resolvingFormatKey = $state<string | null>(null);
  let formatMessage = $state<{ key: string; kind: 'success' | 'danger'; text: string } | null>(
    null
  );

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

  function infoDraft(info: IdentifierInfo | null | undefined): IdentifierInfoDraft {
    return {
      format: info?.format ?? '',
      language: info?.language ?? '',
      publishedDate: info?.publishedDate ?? '',
      pages: info?.pages === null || info?.pages === undefined ? '' : String(info.pages),
      description: info?.description ?? ''
    };
  }

  /** All five fields blank means "no claim": the server deletes the row. */
  function infoPayload(draft: IdentifierInfoDraft): IdentifierInfo | null {
    const empty =
      draft.format.trim() === '' &&
      draft.language.trim() === '' &&
      draft.publishedDate.trim() === '' &&
      draft.pages.trim() === '' &&
      draft.description.trim() === '';
    if (empty) return null;
    return {
      format: valueOrNull(draft.format),
      language: valueOrNull(draft.language),
      publishedDate: valueOrNull(draft.publishedDate),
      pages: intOrNull(draft.pages),
      description: valueOrNull(draft.description)
    };
  }

  function usedEditionIdentifiers(): Array<
    Identifier & {
      info: IdentifierInfo | null;
      publishers: Array<{ id: number } | { name: string; identifiers: Identifier[] }>;
    }
  > {
    return identifiers
      .filter((row) => row.issuer.trim() !== '' || row.value.trim() !== '')
      .map((row) => ({
        issuer: row.issuer.trim(),
        value: row.value.trim(),
        info: row.info ? infoPayload(row.info) : null,
        publishers: publisherPayload(row)
      }));
  }

  /** `id` reuses a catalog publisher; a name creates one at save time. */
  function publisherPayload(
    row: IdentifierRow
  ): Array<{ id: number } | { name: string; identifiers: Identifier[] }> {
    const result: Array<{ id: number } | { name: string; identifiers: Identifier[] }> = [];
    for (const publisher of row.publishers ?? []) {
      if (publisher.id !== null) {
        result.push({ id: publisher.id });
        continue;
      }
      const name = publisher.name.trim();
      if (name !== '') result.push({ name, identifiers: [] });
    }
    return result;
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
      durationSeconds: intOrNull(durationSeconds),
      chapters: intOrNull(chapters),
      series,
      bookEdition: valueOrNull(bookEdition),
      coverUrl: valueOrNull(coverUrl),
      identifiers: usedEditionIdentifiers(),
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

  function addIdentifier(rows: IdentifierRow[], withClaims: boolean) {
    rows.push({
      key: nextKey('identifier'),
      issuer: '',
      value: '',
      ...(withClaims ? { info: { ...EMPTY_INFO } } : {})
    });
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


  // ── Existing contributor/publisher picker ─────────────────────────────────
  let contributorQuery = $state('');
  let contributorMatches = $state<AdminEntityMatch[]>([]);
  let contributorSearching = $state(false);
  let contributorSearchError = $state<string | null>(null);
  let newContributorName = $state('');
  let newContributorIdentifiers = $state<IdentifierRow[]>([
    { key: nextKey('new-contributor-identifier'), issuer: '', value: '' }
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

  // ── Per-identifier publisher picker ───────────────────────────────────────
  async function searchPublishersFor(row: IdentifierRow) {
    row.publisherSearchError = null;
    const query = (row.publisherQuery ?? '').trim();
    if (query === '') {
      row.publisherSearchError = 'Enter a name or identifier.';
      return;
    }
    row.publisherSearching = true;
    try {
      row.publisherMatches = await searchEntities('publisher', query);
      if (row.publisherMatches.length === 0) {
        row.publisherSearchError = 'No local publisher matched; create one with the name below.';
      }
    } catch (error) {
      row.publisherMatches = [];
      row.publisherSearchError = error instanceof Error ? error.message : 'The search failed.';
    } finally {
      row.publisherSearching = false;
    }
  }

  function addPublisherTo(row: IdentifierRow, match: AdminEntityMatch) {
    if (!row.publishers) return;
    if (row.publishers.some((publisher) => publisher.id === match.id)) {
      row.publisherSearchError = 'That publisher is already linked to this identifier.';
      return;
    }
    row.publishers.push({ key: nextKey('publisher'), id: match.id, name: match.name });
    row.publisherMatches = [];
    row.publisherQuery = '';
    row.publisherSearchError = null;
  }

  /** A new publisher entity is created by name at save time (`resolveEntity`). */
  function addNamedPublisherTo(row: IdentifierRow) {
    if (!row.publishers) return;
    const name = (row.publisherQuery ?? '').trim();
    if (name === '') {
      row.publisherSearchError = 'Enter a name for the new publisher.';
      return;
    }
    row.publishers.push({ key: nextKey('publisher'), id: null, name });
    row.publisherQuery = '';
    row.publisherMatches = [];
    row.publisherSearchError = null;
  }

  function removePublisherFrom(row: IdentifierRow, key: string) {
    if (!row.publishers) return;
    const index = row.publishers.findIndex((publisher) => publisher.key === key);
    if (index >= 0) row.publishers.splice(index, 1);
  }

  function applyEdition(edition: AdminEdition) {
    formatMessage = null;
    resolvingFormatKey = null;
    uri = edition.uri;
    rkey = edition.rkey;
    createdAt = edition.createdAt;
    updatedAt = edition.updatedAt;
    indexedAt = edition.indexedAt;
    revision = edition.revision;
    title = edition.title;
    subtitle = edition.subtitle ?? '';
    durationSeconds =
      edition.durationSeconds === null ? '' : String(edition.durationSeconds);
    chapters = edition.chapters === null ? '' : String(edition.chapters);
    seriesName = edition.series?.name ?? '';
    seriesPosition = edition.series?.position ?? '';
    seriesDisplay = edition.series?.display ?? '';
    bookEdition = edition.bookEdition ?? '';
    coverUrl = edition.coverUrl ?? '';
    identifiers = identifierRows(edition.identifiers, 'edition-identifier', true);
    contributors = edition.contributors.map((contributor) => ({
      key: nextKey('contributor'),
      id: contributor.id,
      name: contributor.name,
      role: contributor.role,
      ref: contributor.ref ?? '',
      identifiers: identifierRows(contributor.identifiers, `contributor-${contributor.id}`)
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

  /**
   * Resolve one identifier's format from Goodreads. The claim belongs to the
   * identifier row, so the answer is written into that row's draft and nowhere
   * else; the save is still the operator's.
   */
  async function resolveFormatFor(row: IdentifierRow) {
    const info = row.info;
    if (!info) return;
    formatMessage = null;
    resolvingFormatKey = row.key;
    try {
      const response = await fetch(
        `/admin/api/editions/${encodeURIComponent(rkey)}/resolve-format`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ isbns: [row.value.trim()] })
        }
      );
      if (!response.ok) throw new Error(await responseError(response));
      const payload = (await response.json()) as ResolveFormatResponse;
      if (typeof payload.format !== 'string' || payload.format.trim() === '') {
        throw new Error('Goodreads returned no usable format.');
      }
      info.format = payload.format;
      formatMessage = {
        key: row.key,
        kind: 'success',
        text: `Resolved “${payload.format}” from ISBN ${payload.isbn} using Goodreads. Save the edition to keep it.`
      };
    } catch (error) {
      formatMessage = {
        key: row.key,
        kind: 'danger',
        text: error instanceof Error ? error.message : 'The format lookup failed.'
      };
    } finally {
      resolvingFormatKey = null;
    }
  }

  baseline = JSON.stringify(buildPayload());

  // A client-side navigation between two editor URLs reuses this component;
  // reset only when the loaded edition itself changes, never on invalidate.
  $effect(() => {
    if (data.edition.uri !== uri) applyEdition(data.edition);
  });

</script>

{#snippet identifierEditor(rows: IdentifierRow[], label: string, claims = false)}
  <div class="identifier-list">
    {#each rows as row (row.key)}
      {@const hint = [row.info?.format ?? '', row.info?.language ?? '']
        .map((value) => value.trim())
        .filter(Boolean)
        .join(' · ')}
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
        {#if claims && row.info}
          {@const info = row.info}
          <details class="identifier-info">
            <summary>Shape{hint ? ` — ${hint}` : ''}</summary>
          <div class="identifier-info-grid">
            <div class="field">
              <span class="field-label">Format</span>
              <wa-input
                aria-label={`${label} format`}
                value={info.format}
                placeholder="Paperback, Hardcover, Audiobook…"
                oninput={(event: Event) => (info.format = valueOf(event))}
              ></wa-input>
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                size="small"
                appearance="outlined"
                disabled={resolvingFormatKey !== null ||
                  !['isbn', 'isbn10', 'isbn13'].includes(row.issuer.trim().toLowerCase()) ||
                  row.value.trim() === ''}
                onclick={() => void resolveFormatFor(row)}
              >
                {resolvingFormatKey === row.key ? 'Resolving…' : 'Resolve from Goodreads'}
              </wa-button>
            </div>
            <div class="field">
              <span class="field-label">Language</span>
              <wa-input
                aria-label={`${label} language`}
                value={info.language}
                placeholder="en, en-US, zh-Hant-TW"
                oninput={(event: Event) => (info.language = valueOf(event))}
              ></wa-input>
            </div>
            <div class="field">
              <span class="field-label">Published date</span>
              <wa-input
                aria-label={`${label} published date`}
                value={info.publishedDate}
                placeholder="YYYY, YYYY-MM or YYYY-MM-DD"
                oninput={(event: Event) => (info.publishedDate = valueOf(event))}
              ></wa-input>
            </div>
            <div class="field">
              <span class="field-label">Pages</span>
              <wa-input
                aria-label={`${label} pages`}
                value={info.pages}
                inputmode="numeric"
                placeholder="0"
                oninput={(event: Event) => (info.pages = valueOf(event))}
              ></wa-input>
            </div>
            <div class="field identifier-info-wide">
              <span class="field-label">Description</span>
              <wa-textarea
                aria-label={`${label} description`}
                rows="3"
                value={info.description}
                oninput={(event: Event) => (info.description = valueOf(event))}
              ></wa-textarea>
            </div>
            <div class="field identifier-info-wide">
              <span class="field-label">Publishers</span>
              {#if row.publishers}
                {#if row.publishers.length > 0}
                  <div class="wa-cluster wa-gap-3xs">
                    {#each row.publishers as publisher (publisher.key)}
                      <wa-tag size="small" variant="neutral">
                        {publisher.name}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                        <wa-button
                          size="small"
                          appearance="plain"
                          aria-label={`Remove publisher ${publisher.name}`}
                          onclick={() => removePublisherFrom(row, publisher.key)}>Remove</wa-button
                        >
                      </wa-tag>
                    {/each}
                  </div>
                {/if}
                <div class="publisher-search">
                  <wa-input
                    aria-label={`${label} publisher search`}
                    role="textbox"
                    tabindex="0"
                    value={row.publisherQuery ?? ''}
                    placeholder="Search a publisher by name or identifier"
                    oninput={(event: Event) => (row.publisherQuery = valueOf(event))}
                    onkeydown={(event: KeyboardEvent) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void searchPublishersFor(row);
                      }
                    }}
                  ></wa-input>
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button
                    size="small"
                    disabled={row.publisherSearching}
                    onclick={() => void searchPublishersFor(row)}
                  >
                    {row.publisherSearching ? 'Searching…' : 'Search'}
                  </wa-button>
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <wa-button size="small" appearance="outlined" onclick={() => addNamedPublisherTo(row)}>
                    Create
                  </wa-button>
                </div>
                {#if row.publisherSearchError}
                  <span class="field-error">{row.publisherSearchError}</span>
                {/if}
                {#if row.publisherMatches && row.publisherMatches.length > 0}
                  <div class="match-list">
                    {#each row.publisherMatches as match (match.id)}
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
                        <wa-button size="small" onclick={() => addPublisherTo(row, match)}>
                          Add
                        </wa-button>
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
              <span class="muted admin-small">
                The record publishes the first publisher in identifier order. Search reuses an
                existing entity; Create makes one from the typed name when the edition is saved.
              </span>
            </div>
          </div>
          <span class="muted admin-small">
            What this identifier's own record claims; the edition's public shape is the union
            (isbn13 first). Empty fields fall back to another identifier, not to the record.
          </span>
          {#if formatMessage?.key === row.key}
            <wa-callout variant={formatMessage.kind}>{formatMessage.text}</wa-callout>
          {/if}
          </details>
        {/if}
      </div>
    {/each}
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <wa-button size="small" appearance="outlined" onclick={() => addIdentifier(rows, claims)}>
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
            <span class="field-label">Book edition</span>
            <wa-input
              aria-label="Book edition"
              value={bookEdition}
              placeholder="2nd revised"
              oninput={(event: Event) => (bookEdition = valueOf(event))}
            ></wa-input>
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
        {@render identifierEditor(identifiers, 'Edition identifier', true)}
        {#if sectionErrors('identifiers').length > 0}
          <span class="field-error">{sectionErrors('identifiers').join(' · ')}</span>
        {/if}
      </div>
    </wa-card>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Contributors</h2>
      <div class="wa-stack wa-gap-m">
        <p class="muted admin-small">
          Order is the record order. Role must normalise to a known ONIX Codelist 17 code, for
          example A01 author, B06 translator or E03 narrator; legacy names such as “editor” map to
          B01. An existing row keeps its catalog entity; editing its name or identifiers here is not
          allowed.
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

  /* The claim panel spans all three columns of the identifier row. */
  .identifier-info {
    grid-column: 1 / -1;
  }

  .identifier-info summary {
    cursor: pointer;
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-text-quiet);
  }

  .identifier-info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--wa-space-xs);
    padding-block: var(--wa-space-xs);
  }

  .identifier-info-wide {
    grid-column: 1 / -1;
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

  .publisher-search {
    display: flex;
    gap: var(--wa-space-2xs);
    align-items: center;
    flex-wrap: wrap;
  }

  .publisher-search wa-input {
    flex: 1 1 12rem;
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
