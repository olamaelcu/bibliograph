<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MERGE_FIELDS,
    PROVIDERS,
    identifierText,
    type AdminEdition,
    type AdminEntityMatch,
    type AdminEntitySearchResponse,
    type Candidate,
    type ContributorCandidate,
    type ContributorSearchResponse,
    type IngestResponse,
    type LinkMode,
    type MergeField,
    type MergeRequest,
    type MergeResponse,
    type Provider,
    type ProviderSearchResponse,
    type PublisherBooksResponse,
    type PublisherImportResponse,
    type PublisherSearchResponse,
    type ReportRegistryResponse,
    type ReportResponse,
    type ReportRow,
    type ReportSummary
  } from '$lib/admin/types';

  const PROVIDER_LABELS: Record<Provider, string> = {
    googlebooks: 'Google Books',
    isbndb: 'ISBNdb',
    openlibrary: 'OpenLibrary',
    goodreads: 'Goodreads'
  };

  type AdminTab =
    | 'provider'
    | 'publisher'
    | 'edit'
    | 'contributors'
    | 'publishers'
    | 'merge'
    | 'reports';

  function isAdminTab(value: string): value is AdminTab {
    return (
      value === 'provider' ||
      value === 'publisher' ||
      value === 'edit' ||
      value === 'contributors' ||
      value === 'publishers' ||
      value === 'merge' ||
      value === 'reports'
    );
  }

  let activeTab = $state<AdminTab>('provider');

  // The Web Awesome tab group owns click/keyboard activation; mirror it into
  // state so actions elsewhere can switch panels.
  function onTabShow(event: Event) {
    const name = (event as CustomEvent<{ name?: unknown }>).detail?.name;
    if (typeof name === 'string' && isAdminTab(name)) {
      activeTab = name;
      if (name === 'reports') void loadReports();
    }
  }

  onMount(() => {
    const applyHash = () => {
      const name = window.location.hash.replace(/^#/, '');
      if (name === '') activeTab = 'provider';
      else if (isAdminTab(name)) activeTab = name;
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    if (activeTab === 'reports') void loadReports();
    return () => window.removeEventListener('hashchange', applyHash);
  });

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

  // ── Contributor search (OpenLibrary, read-only) ───────────────────────────
  let contributorQuery = $state('');
  let contributors = $state<ContributorCandidate[]>([]);
  let contributorSearching = $state(false);
  let contributorError = $state<string | null>(null);

  async function runContributorSearch() {
    contributorError = null;
    if (contributorQuery.trim() === '') {
      contributorError = 'Enter an author name.';
      return;
    }
    contributorSearching = true;
    try {
      const response = await fetch('/admin/api/contributor-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: contributorQuery, limit: 20 })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ContributorSearchResponse;
      contributors = Array.isArray(body.contributors) ? body.contributors : [];
      if (contributors.length === 0) contributorError = 'OpenLibrary returned no contributors.';
    } catch (error) {
      contributorError = error instanceof Error ? error.message : 'The search failed.';
      contributors = [];
    } finally {
      contributorSearching = false;
    }
  }

  // ── ISBNdb publisher import ───────────────────────────────────────────────
  let publisherQuery = $state('');
  let publisherNames = $state<string[]>([]);
  let publisherName = $state('');
  let publisherFrom = $state('');
  let publisherTo = $state('');
  let publisherLanguage = $state('');
  let publisherPageSize = $state('100');
  let publisherMaxPages = $state('1');
  let publisherBooks = $state<Candidate[]>([]);
  let publisherSelected = $state<Record<string, boolean>>({});
  let publisherTotal = $state(0);
  let publisherPage = $state(1);
  let publisherSearching = $state(false);
  let publisherLoading = $state(false);
  let publisherImporting = $state(false);
  let publisherError = $state<string | null>(null);
  let publisherNotice = $state<string | null>(null);
  let publisherImportResult = $state<PublisherImportResponse | null>(null);
  let publisherContinuePage = $state<number | null>(null);

  const publisherPageCount = $derived(
    Math.max(1, Math.ceil(publisherTotal / Number(publisherPageSize)))
  );
  const publisherSelectedKeys = $derived(
    publisherBooks
      .map((candidate) => candidateKey(candidate))
      .filter((key) => publisherSelected[key] !== false)
  );

  function selectPublisher(name: string) {
    publisherName = name;
    publisherBooks = [];
    publisherSelected = {};
    publisherTotal = 0;
    publisherPage = 1;
    publisherImportResult = null;
    publisherContinuePage = null;
    publisherNotice = null;
    publisherError = null;
  }

  async function runPublisherSearch() {
    publisherError = null;
    publisherNotice = null;
    const text = publisherQuery.trim();
    if (text === '') {
      publisherError = 'Enter a publisher name.';
      return;
    }
    publisherSearching = true;
    try {
      const response = await fetch('/admin/api/publisher-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text, page: 1, pageSize: 50 })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as PublisherSearchResponse;
      publisherNames = Array.isArray(body.publishers) ? body.publishers : [];
      if (publisherNames.length === 0) publisherError = 'ISBNdb returned no matching publishers.';
    } catch (error) {
      publisherError = error instanceof Error ? error.message : 'The publisher search failed.';
      publisherNames = [];
    } finally {
      publisherSearching = false;
    }
  }

  function publisherFilterBody(): Record<string, string> {
    const filters: Record<string, string> = {};
    const from = publisherFrom.trim();
    const to = publisherTo.trim();
    const language = publisherLanguage.trim();
    if (from !== '') filters.publishedFrom = from;
    if (to !== '') filters.publishedTo = to;
    if (language !== '') filters.language = language;
    return filters;
  }

  async function loadPublisherPage(page: number) {
    if (publisherName === '') return;
    publisherLoading = true;
    publisherError = null;
    publisherNotice = null;
    try {
      const response = await fetch('/admin/api/publisher-books', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: publisherName,
          page,
          pageSize: Number(publisherPageSize),
          ...publisherFilterBody()
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as PublisherBooksResponse;
      publisherBooks = Array.isArray(body.candidates) ? body.candidates : [];
      publisherTotal = Number(body.total) || 0;
      publisherPage = Number(body.page) || page;
      publisherSelected = Object.fromEntries(
        publisherBooks.map((candidate) => [candidateKey(candidate), true])
      );
      publisherImportResult = null;
      publisherContinuePage = null;
      if (publisherBooks.length === 0) {
        publisherError = 'That publisher has no books for these filters.';
      }
    } catch (error) {
      publisherError = error instanceof Error ? error.message : 'Loading the publisher failed.';
      publisherBooks = [];
    } finally {
      publisherLoading = false;
    }
  }

  async function importPublisherSelection() {
    const chosen = publisherBooks.filter(
      (candidate) => publisherSelected[candidateKey(candidate)] !== false
    );
    if (chosen.length === 0) {
      publisherError = 'Select at least one book to import.';
      return;
    }
    publisherImporting = true;
    publisherError = null;
    publisherNotice = null;
    publisherImportResult = null;
    publisherContinuePage = null;
    let created = 0;
    let existing = 0;
    let failed = 0;
    let firstError: string | null = null;
    try {
      for (const candidate of chosen) {
        const key = candidateKey(candidate);
        ingestStatus = { ...ingestStatus, [key]: 'pending' };
        try {
          const response = await fetch('/admin/api/ingest', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ candidate })
          });
          if (!response.ok) throw new Error(await responseError(response));
          const body = (await response.json()) as IngestResponse;
          ingestStatus = { ...ingestStatus, [key]: 'done' };
          if (body.created) created += 1;
          else existing += 1;
        } catch (error) {
          ingestStatus = { ...ingestStatus };
          delete ingestStatus[key];
          failed += 1;
          if (firstError === null) {
            firstError = error instanceof Error ? error.message : 'Ingestion failed.';
          }
        }
      }
      const suffix = failed > 0 ? `, ${failed} failed.` : '.';
      publisherNotice = `Imported ${created + existing} selected books: ${created} created, ${existing} already in the catalog${suffix}`;
      if (firstError !== null) publisherError = firstError;
    } finally {
      publisherImporting = false;
    }
  }

  async function runPublisherImport(page = publisherPage) {
    if (publisherName === '') return;
    publisherImporting = true;
    publisherError = null;
    publisherNotice = null;
    try {
      const response = await fetch('/admin/api/publisher-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: publisherName,
          page,
          pageSize: Number(publisherPageSize),
          maxPages: Number(publisherMaxPages),
          ...publisherFilterBody()
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as PublisherImportResponse;
      publisherImportResult = body;
      publisherContinuePage = Number.isInteger(body.nextPage) ? body.nextPage : null;
    } catch (error) {
      publisherError = error instanceof Error ? error.message : 'The publisher import failed.';
    } finally {
      publisherImporting = false;
    }
  }

  // ── Edition editor search ────────────────────────────────────────────────
  let editQuery = $state('');
  let editResults = $state<AdminEdition[]>([]);
  let editSearching = $state(false);
  let editError = $state<string | null>(null);
  let editSearched = $state(false);
  let editSequence = 0;

  // A query that is an at-URI or a single rkey-shaped token can be opened
  // directly, even when the catalog search returns no list.
  const editDirectRef = $derived.by(() => {
    const value = editQuery.trim();
    if (value === '') return null;
    if (value.startsWith('at://')) return value;
    if (/%3A/i.test(value)) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded.startsWith('at://')) return decoded;
      } catch {
        // Fall through to the rkey-shaped check.
      }
    }
    return /^[A-Za-z0-9._~:-]{1,512}$/.test(value) ? value : null;
  });

  // Prefer the rkey from an at-URI: the editor route accepts either, and a
  // bare rkey avoids encoded slashes in the browser path.
  const editDirectHref = $derived.by(() => {
    const ref = editDirectRef;
    if (ref === null) return null;
    const rkey = ref.startsWith('at://') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
    if (rkey === '') return null;
    return `/admin/edition/${encodeURIComponent(rkey)}/edit`;
  });

  async function runEditSearch() {
    editError = null;
    editSearched = true;
    const q = editQuery.trim();
    if (q === '') {
      editResults = [];
      editError = 'Enter a title, identifier, rkey or at-URI.';
      return;
    }
    const sequence = ++editSequence;
    editSearching = true;
    try {
      const response = await fetch(`/admin/api/editions?q=${encodeURIComponent(q)}&limit=20`, {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as { items?: AdminEdition[] };
      if (sequence !== editSequence) return;
      editResults = Array.isArray(body.items) ? body.items : [];
    } catch (error) {
      if (sequence !== editSequence) return;
      editError = error instanceof Error ? error.message : 'The local search failed.';
      editResults = [];
    } finally {
      if (sequence === editSequence) editSearching = false;
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
    activeTab = 'merge';
    await runEditionSearch();
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

  // ── Local contributor and publisher editors ──────────────────────────────
  //
  // Two independent panels, each with its own search state, both fed by the
  // local entity typeahead. A row links to its dedicated editor; nothing here
  // shares state with an edition editor or with the merge workbench.
  type EntityEditSearch = {
    query: string;
    items: AdminEntityMatch[];
    searching: boolean;
    error: string | null;
    searched: boolean;
    sequence: number;
  };

  function emptyEntityEditSearch(): EntityEditSearch {
    return { query: '', items: [], searching: false, error: null, searched: false, sequence: 0 };
  }

  let contributorEditSearch = $state<EntityEditSearch>(emptyEntityEditSearch());
  let publisherEditSearch = $state<EntityEditSearch>(emptyEntityEditSearch());

  async function runEntityEditSearch(
    state: EntityEditSearch,
    type: 'contributor' | 'publisher'
  ): Promise<void> {
    const text = state.query.trim();
    if (text === '') {
      state.error = 'Enter a name or identifier.';
      state.items = [];
      state.searched = false;
      return;
    }
    const sequence = ++state.sequence;
    state.searching = true;
    state.error = null;
    state.items = [];
    try {
      const params = new URLSearchParams({ type, q: text, limit: '20' });
      const response = await fetch(`/admin/api/entity-search?${params.toString()}`, {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as AdminEntitySearchResponse;
      if (sequence !== state.sequence) return;
      state.items = Array.isArray(body.items) ? body.items : [];
      state.searched = true;
    } catch (error) {
      if (sequence !== state.sequence) return;
      state.error = error instanceof Error ? error.message : 'The local search failed.';
      state.items = [];
      state.searched = false;
    } finally {
      if (sequence === state.sequence) state.searching = false;
    }
  }

  // ── Reports ─────────────────────────────────────────────────────────────
  //
  // The registry is served by the edge; every report query is read-only and
  // paginated server-side. Rows arrive JSON-safe, and edition rows carry their
  // canonical stored at-URI.
  let reports = $state<ReportSummary[]>([]);
  let reportsLoading = $state(false);
  let reportsLoaded = $state(false);
  let reportsError = $state<string | null>(null);
  let selectedReportId = $state('');
  let reportParamValues = $state<Record<string, string>>({});
  let reportRows = $state<ReportRow[]>([]);
  let reportTotal = $state(0);
  let reportLimit = $state(25);
  let reportOffset = $state(0);
  let reportLoading = $state(false);
  let reportError = $state<string | null>(null);
  let reportRan = $state(false);
  let reportSequence = 0;

  const selectedReport = $derived(
    reports.find((report) => report.id === selectedReportId) ?? null
  );
  const reportPage = $derived(Math.floor(reportOffset / reportLimit) + 1);
  const reportPageCount = $derived(Math.max(1, Math.ceil(reportTotal / reportLimit)));
  const reportRangeStart = $derived(reportRows.length === 0 ? 0 : reportOffset + 1);
  const reportRangeEnd = $derived(Math.min(reportOffset + reportRows.length, reportTotal));

  function selectReport(id: string) {
    selectedReportId = id;
    const report = reports.find((entry) => entry.id === id) ?? null;
    const defaults: Record<string, string> = {};
    for (const param of report?.params ?? []) defaults[param.key] = param.defaultValue;
    reportParamValues = defaults;
    reportRows = [];
    reportTotal = 0;
    reportOffset = 0;
    reportError = null;
    reportRan = false;
  }

  function setReportParam(key: string, value: string) {
    reportParamValues = { ...reportParamValues, [key]: value };
  }

  async function loadReports() {
    if (reportsLoading || reportsLoaded) return;
    reportsLoading = true;
    reportsError = null;
    try {
      const response = await fetch('/admin/api/reports', { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ReportRegistryResponse;
      reports = Array.isArray(body.reports) ? body.reports : [];
      reportsLoaded = true;
      const first = reports[0];
      if (selectedReportId === '' && first) {
        selectReport(first.id);
        await runReport(0);
      }
    } catch (error) {
      reportsError = error instanceof Error ? error.message : 'The report list failed to load.';
      reports = [];
    } finally {
      reportsLoading = false;
    }
  }

  async function onSelectReport(event: Event) {
    selectReport(valueOf(event));
    await runReport(0);
  }

  function setReportLimit(value: string) {
    const parsed = Number(value);
    reportLimit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 25;
    void runReport(0);
  }

  async function runReport(offset: number) {
    const report = selectedReport;
    if (!report) return;
    const sequence = ++reportSequence;
    reportLoading = true;
    reportError = null;
    try {
      const params = new URLSearchParams({ limit: String(reportLimit), offset: String(offset) });
      for (const spec of report.params) {
        const value = reportParamValues[spec.key] ?? spec.defaultValue;
        if (value !== '') params.set(spec.key, value);
      }
      const response = await fetch(
        `/admin/api/reports/${encodeURIComponent(report.id)}?${params.toString()}`,
        { cache: 'no-store' }
      );
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ReportResponse;
      if (sequence !== reportSequence) return;
      reportRows = Array.isArray(body.rows) ? body.rows : [];
      reportTotal = typeof body.total === 'number' ? body.total : 0;
      reportOffset = typeof body.offset === 'number' ? body.offset : offset;
      reportRan = true;
    } catch (error) {
      if (sequence !== reportSequence) return;
      reportError = error instanceof Error ? error.message : 'The report query failed.';
      reportRows = [];
      reportTotal = 0;
      reportRan = true;
    } finally {
      if (sequence === reportSequence) reportLoading = false;
    }
  }

  function reportText(row: ReportRow, key: string): string {
    const value = row[key];
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return value === '' ? '—' : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join(', ');
    }
    return JSON.stringify(value);
  }

  function reportDate(value: unknown): string {
    if (typeof value !== 'string' || value === '') return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : isoDate(value);
  }

  type ReportEditionLink = { uri: string; rkey: string; title: string };

  function reportEditions(row: ReportRow, key: string): ReportEditionLink[] {
    const value = row[key];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ReportEditionLink => {
      if (entry === null || typeof entry !== 'object') return false;
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.uri === 'string' &&
        typeof candidate.rkey === 'string' &&
        typeof candidate.title === 'string'
      );
    });
  }

  function reportRowKey(row: ReportRow, index: number): string {
    for (const key of ['uri', 'at_uri', 'issuer', 'id']) {
      const value = row[key];
      if (typeof value === 'string' || typeof value === 'number') return `${key}:${value}:${index}`;
    }
    return `row:${index}`;
  }
</script>

{#snippet entityEditPanel(
  state: EntityEditSearch,
  type: 'contributor' | 'publisher',
  heading: string,
  blurb: string
)}
  <div class="admin-content wa-stack wa-gap-l">
    <div class="wa-stack wa-gap-2xs">
      <h2>{heading}</h2>
      <p class="muted">{blurb}</p>
    </div>

    <wa-card with-header appearance="outlined">
      <h3 slot="header">Find a local {type} to edit</h3>
      <div class="wa-stack wa-gap-m">
        <div class="admin-form-grid">
          <div class="field field-grow">
            <span class="field-label">Name or identifier</span>
            <wa-input
              aria-label={`Find a local ${type} to edit`}
              role="textbox"
              tabindex="0"
              value={state.query}
              placeholder="Name, issuer:value or an identifier value"
              oninput={(event: Event) => (state.query = valueOf(event))}
              onkeydown={(event: KeyboardEvent) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runEntityEditSearch(state, type);
                }
              }}
            ></wa-input>
          </div>
          <div class="admin-form-action">
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <wa-button
              variant="brand"
              disabled={state.searching}
              onclick={() => void runEntityEditSearch(state, type)}
            >
              {state.searching ? 'Searching…' : `Search ${type}s`}
            </wa-button>
          </div>
        </div>

        {#if state.error}
          <wa-callout variant="danger">{state.error}</wa-callout>
        {/if}

        {#if state.searching}
          <p class="muted admin-small">Searching local {type} rows…</p>
        {:else if state.items.length > 0}
          <div class="table-scroll">
            <table class="params admin-preview-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Identifiers</th>
                  <th>Canonical AT URI</th>
                  <th>ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each state.items as item (item.id)}
                  <tr>
                    <td><strong>{item.name}</strong></td>
                    <td>
                      {#if item.identifiers.length > 0}
                        <div class="wa-cluster wa-gap-2xs">
                          {#each item.identifiers as identifier, index (index)}
                            <wa-tag size="small" variant="neutral">
                              {identifierText(identifier)}
                            </wa-tag>
                          {/each}
                        </div>
                      {:else}
                        <span class="muted admin-small">None</span>
                      {/if}
                    </td>
                    <td>
                      {#if item.ref}
                        <code class="admin-wrap admin-small">{item.ref}</code>
                      {:else}
                        <span class="muted admin-small">Not minted yet</span>
                      {/if}
                    </td>
                    <td><code>{item.id}</code></td>
                    <td>
                      <a class="admin-small" href={`/admin/${type}/${item.id}/edit`}>
                        Edit {type}
                      </a>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if state.searched}
          <p class="muted">No local {type}s matched.</p>
        {/if}
      </div>
    </wa-card>
  </div>
{/snippet}

<main class="admin-main">
  <wa-tab-group class="admin-tabs" active={activeTab} onwa-tab-show={onTabShow}>
    <wa-tab slot="nav" panel="provider">Provider search</wa-tab>
    <wa-tab slot="nav" panel="publisher">Publisher import</wa-tab>
    <wa-tab slot="nav" panel="edit">Edit edition</wa-tab>
    <wa-tab slot="nav" panel="contributors">Edit contributors</wa-tab>
    <wa-tab slot="nav" panel="publishers">Edit publishers</wa-tab>
    <wa-tab slot="nav" panel="merge">Merge editions</wa-tab>
    <wa-tab slot="nav" panel="reports">Reports</wa-tab>

    <wa-tab-panel name="provider" active={activeTab === 'provider'}>
  <section class="section" id="provider">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h1>Catalog curation</h1>
        <p class="lede">
          Search a catalog provider and ingest one result, bulk-import an ISBNdb publisher's books,
          then reconcile duplicate edition records in the local catalog.
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
                  <a
                    class="admin-small"
                    href={`/admin/edition/${encodeURIComponent(
                      lastIngest!.uri.slice(lastIngest!.uri.lastIndexOf('/') + 1)
                    )}/edit`}
                  >
                    Edit edition
                  </a>
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

      <wa-card with-header appearance="outlined">
        <h2 slot="header">Contributor search (OpenLibrary, read-only)</h2>
        <div class="wa-stack wa-gap-m">
          <p class="muted">
            Look up descriptive author data for catalog contributor records. Results include the
            OpenLibrary author key, reliable external identifiers and full dates only. This panel
            does not import or publish contributors.
          </p>
          <div class="admin-form-grid">
            <div class="field field-grow">
              <span class="field-label">Author name</span>
              <wa-input
                aria-label="Author name"
                role="textbox"
                tabindex="0"
                value={contributorQuery}
                placeholder="Author name"
                oninput={(event: Event) => (contributorQuery = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runContributorSearch();
                  }
                }}
              ></wa-input>
            </div>
            <div class="admin-form-action">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                variant="brand"
                disabled={contributorSearching}
                onclick={() => void runContributorSearch()}
              >
                {contributorSearching ? 'Searching…' : 'Search contributors'}
              </wa-button>
            </div>
          </div>

          {#if contributorError}
            <wa-callout variant="danger">{contributorError}</wa-callout>
          {/if}

          {#if contributors.length > 0}
            <div class="admin-results">
              {#each contributors as contributor (contributor.key ?? contributor.displayName)}
                <wa-card appearance="outlined" class="admin-result">
                  <div class="admin-result-row">
                    {#if contributor.imageUrl}
                      <img
                        class="admin-cover"
                        src={contributor.imageUrl}
                        alt=""
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    {/if}
                    <div class="wa-stack wa-gap-2xs admin-result-body">
                      <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                        <strong>{contributor.displayName}</strong>
                        {#if contributor.born}
                          <span class="muted">born {contributor.born}</span>
                        {/if}
                        {#if contributor.died}
                          <span class="muted">died {contributor.died}</span>
                        {/if}
                      </div>
                      {#if contributor.description}
                        <span class="muted admin-small">{contributor.description}</span>
                      {/if}
                      <div class="wa-cluster wa-gap-2xs">
                        {#each contributor.identifiers as identifier (identifierText(identifier))}
                          <wa-tag size="small" variant="neutral">
                            {identifierText(identifier)}
                          </wa-tag>
                        {/each}
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
    </wa-tab-panel>

    <wa-tab-panel name="publisher" active={activeTab === 'publisher'}>
  <section class="section" id="publisher">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h2>2 · Publisher import (ISBNdb)</h2>
        <p class="muted">
          Search ISBNdb publisher names, preview a publisher's books with publication and language
          filters, then ingest the books you select or whole pages in bulk. Only books carrying a
          valid ISBN-13 can be imported.
        </p>
      </div>

      <wa-card with-header appearance="outlined">
        <h3 slot="header">Find an ISBNdb publisher</h3>
        <div class="wa-stack wa-gap-m">
          <div class="admin-form-grid">
            <div class="field field-grow">
              <span class="field-label">Publisher name</span>
              <wa-input
                aria-label="Publisher name"
                role="textbox"
                tabindex="0"
                value={publisherQuery}
                placeholder="Publisher name"
                oninput={(event: Event) => (publisherQuery = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runPublisherSearch();
                  }
                }}
              ></wa-input>
            </div>
            <div class="admin-form-action">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                variant="brand"
                disabled={publisherSearching}
                onclick={() => void runPublisherSearch()}
              >
                {publisherSearching ? 'Searching…' : 'Search publishers'}
              </wa-button>
            </div>
          </div>

          {#if publisherNames.length > 0}
            <div class="field">
              <span class="field-label">Publisher</span>
              <wa-select
                aria-label="Publisher"
                value={publisherName}
                onchange={(event: Event) => selectPublisher(valueOf(event))}
              >
                <wa-option value="">Choose a publisher…</wa-option>
                {#each publisherNames as name (name)}
                  <wa-option value={name}>{name}</wa-option>
                {/each}
              </wa-select>
            </div>
          {/if}

          {#if publisherError && publisherName === ''}
            <wa-callout variant="danger">{publisherError}</wa-callout>
          {/if}
        </div>
      </wa-card>

      {#if publisherName !== ''}
        <wa-card with-header appearance="outlined">
          <h3 slot="header">Books by {publisherName}</h3>
          <div class="wa-stack wa-gap-m">
            <div class="admin-form-grid">
              <div class="field">
                <span class="field-label">Published from</span>
                <wa-input
                  aria-label="Published from"
                  role="textbox"
                  tabindex="0"
                  value={publisherFrom}
                  placeholder="YYYY, YYYY-MM or YYYY-MM-DD"
                  oninput={(event: Event) => (publisherFrom = valueOf(event))}
                ></wa-input>
              </div>
              <div class="field">
                <span class="field-label">Published to</span>
                <wa-input
                  aria-label="Published to"
                  role="textbox"
                  tabindex="0"
                  value={publisherTo}
                  placeholder="YYYY, YYYY-MM or YYYY-MM-DD"
                  oninput={(event: Event) => (publisherTo = valueOf(event))}
                ></wa-input>
              </div>
              <div class="field">
                <span class="field-label">Language</span>
                <wa-input
                  aria-label="Language"
                  role="textbox"
                  tabindex="0"
                  value={publisherLanguage}
                  placeholder="eng"
                  oninput={(event: Event) => (publisherLanguage = valueOf(event))}
                ></wa-input>
              </div>
              <div class="field">
                <span class="field-label">Page size</span>
                <wa-select
                  aria-label="Page size"
                  value={publisherPageSize}
                  onchange={(event: Event) => (publisherPageSize = valueOf(event))}
                >
                  <wa-option value="50">50</wa-option>
                  <wa-option value="100">100</wa-option>
                </wa-select>
              </div>
              <div class="admin-form-action">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button disabled={publisherLoading} onclick={() => void loadPublisherPage(1)}>
                  {publisherLoading ? 'Loading…' : 'Load books'}
                </wa-button>
              </div>
            </div>

            {#if publisherTotal > 0}
              <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                <strong>{publisherTotal} books</strong>
                <span class="muted">Page {publisherPage} of {publisherPageCount}</span>
              </div>
            {/if}

            {#if publisherBooks.length > 0}
              <div class="admin-results">
                {#each publisherBooks as candidate, index (candidateKey(candidate) + index)}
                  <wa-card appearance="outlined" class="admin-result">
                    <div class="admin-result-row admin-result-select">
                      <wa-checkbox
                        aria-label={`Include ${candidate.title}`}
                        checked={publisherSelected[candidateKey(candidate)] !== false}
                        onchange={(event: Event) =>
                          (publisherSelected = {
                            ...publisherSelected,
                            [candidateKey(candidate)]: checkedOf(event)
                          })}
                      ></wa-checkbox>
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
                        {#if candidate.publisher}
                          <span class="muted admin-small">{candidate.publisher.name}</span>
                        {/if}
                      </div>
                    </div>
                  </wa-card>
                {/each}
              </div>
            {/if}

            <div class="wa-cluster wa-gap-s">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                disabled={publisherLoading || publisherPage <= 1}
                onclick={() => void loadPublisherPage(publisherPage - 1)}
              >
                Previous
              </wa-button>
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                disabled={publisherLoading || publisherPage >= publisherPageCount}
                onclick={() => void loadPublisherPage(publisherPage + 1)}
              >
                Next
              </wa-button>
            </div>

            <div class="admin-form-grid">
              <div class="admin-form-action">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  variant="brand"
                  disabled={publisherImporting || publisherSelectedKeys.length === 0}
                  onclick={() => void importPublisherSelection()}
                >
                  Import selected ({publisherSelectedKeys.length})
                </wa-button>
              </div>
              <div class="field">
                <span class="field-label">Pages to import</span>
                <wa-input
                  aria-label="Pages to import"
                  type="number"
                  min="1"
                  max="5"
                  value={publisherMaxPages}
                  oninput={(event: Event) => (publisherMaxPages = valueOf(event))}
                ></wa-input>
              </div>
              <div class="admin-form-action">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  disabled={publisherImporting}
                  onclick={() => void runPublisherImport(publisherPage)}
                >
                  Import pages {publisherPage}–{Math.min(
                    publisherPage + Number(publisherMaxPages) - 1,
                    publisherPageCount
                  )}
                </wa-button>
              </div>
            </div>

            {#if publisherContinuePage !== null}
              <div class="wa-cluster wa-gap-s">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  disabled={publisherImporting}
                  onclick={() => void runPublisherImport(publisherContinuePage!)}
                >
                  Continue from page {publisherContinuePage}
                </wa-button>
              </div>
            {/if}

            {#if publisherNotice}
              <wa-callout variant="success">{publisherNotice}</wa-callout>
            {/if}
            {#if publisherError && publisherName !== ''}
              <wa-callout variant="danger">{publisherError}</wa-callout>
            {/if}

            {#if publisherImportResult}
              <wa-callout
                variant={publisherImportResult.stopped === 'quota_exhausted' ? 'warning' : 'success'}
              >
                <div class="wa-stack wa-gap-2xs">
                  <strong>
                    {publisherImportResult.stopped === 'quota_exhausted'
                      ? 'ISBNdb quota exhausted — import stopped early.'
                      : `Imported ${publisherImportResult.imported} books.`}
                  </strong>
                  <span class="muted">
                    {publisherImportResult.created} created ·
                    {publisherImportResult.existing} already in the catalog ·
                    {publisherImportResult.failed} failed ·
                    {publisherImportResult.pagesFetched} page(s) read.
                  </span>
                  {#if publisherImportResult.stopped === 'quota_exhausted'}
                    <span class="muted">
                      Retry after 00:00 UTC; already imported books are not duplicated.
                    </span>
                  {/if}
                  {#if publisherImportResult.failures.length > 0}
                    <ul class="admin-deleted">
                      {#each publisherImportResult.failures as failure (failure.title)}
                        <li><strong>{failure.title}</strong> — {failure.message}</li>
                      {/each}
                    </ul>
                  {/if}
                  {#if publisherContinuePage !== null}
                    <span class="muted">
                      More results remain; continue from page {publisherContinuePage}.
                    </span>
                  {/if}
                </div>
              </wa-callout>
            {/if}
          </div>
        </wa-card>
      {/if}
    </div>
  </section>
    </wa-tab-panel>

    <wa-tab-panel name="edit" active={activeTab === 'edit'}>
  <section class="section" id="edit">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h2>3 · Edit an edition</h2>
        <p class="muted">
          Search the local catalog by title, identifier, rkey or at-URI, then open the full record
          editor. Editing is separate from merge selection.
        </p>
      </div>

      <wa-card with-header appearance="outlined">
        <h3 slot="header">Find a local edition to edit</h3>
        <div class="wa-stack wa-gap-m">
          <div class="admin-form-grid">
            <div class="field field-grow">
              <span class="field-label">Title, identifier, rkey or at-URI</span>
              <wa-input
                aria-label="Find an edition to edit"
                role="textbox"
                tabindex="0"
                value={editQuery}
                placeholder="Title, ISBN, issuer:value, rkey or at://…"
                oninput={(event: Event) => (editQuery = valueOf(event))}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runEditSearch();
                  }
                }}
              ></wa-input>
            </div>
            <div class="admin-form-action">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <wa-button
                variant="brand"
                disabled={editSearching}
                onclick={() => void runEditSearch()}
              >
                {editSearching ? 'Searching…' : 'Search editions'}
              </wa-button>
            </div>
          </div>

          {#if editDirectRef && editDirectHref}
            <wa-callout variant="neutral">
              <div class="wa-stack wa-gap-2xs">
                <strong>Open directly</strong>
                <span class="muted admin-small">
                  This value looks like an rkey or at-URI; open the editor without waiting for a
                  search result.
                </span>
                <a
                  class="admin-small admin-wrap"
                  href={editDirectHref}
                >
                  Open {editDirectRef}
                </a>
              </div>
            </wa-callout>
          {/if}

          {#if editError}
            <wa-callout variant="danger">{editError}</wa-callout>
          {/if}

          {#if editSearching}
            <p class="muted admin-small">Searching the catalog…</p>
          {/if}

          {#if editResults.length > 0}
            <div class="admin-results">
              {#each editResults as record (record.uri)}
                <wa-card appearance="outlined" class="admin-result">
                  <div class="wa-stack wa-gap-2xs admin-result-body">
                    <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                      <strong>{record.title}</strong>
                      {#if record.publishedDate}
                        <span class="muted">{record.publishedDate}</span>
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
                      <code>{record.rkey}</code> · {record.uri}
                    </span>
                    <a
                      class="admin-small"
                      href={`/admin/edition/${encodeURIComponent(record.rkey)}/edit`}
                    >
                      Edit edition
                    </a>
                  </div>
                </wa-card>
              {/each}
            </div>
          {:else if editSearched && !editSearching && !editError && !editDirectRef}
            <p class="muted">No local editions matched.</p>
          {/if}
        </div>
      </wa-card>
    </div>
  </section>
    </wa-tab-panel>

    <wa-tab-panel name="contributors" active={activeTab === 'contributors'}>
  <section class="section" id="contributors">
    {@render entityEditPanel(
      contributorEditSearch,
      'contributor',
      '4 · Edit contributors',
      'Search local contributor rows by name or identifier, then open the dedicated editor. Saving changes the shared row, queues its record and republishes any edition that credits its name or identifiers. Nothing is deleted.'
    )}
  </section>
    </wa-tab-panel>

    <wa-tab-panel name="publishers" active={activeTab === 'publishers'}>
  <section class="section" id="publishers">
    {@render entityEditPanel(
      publisherEditSearch,
      'publisher',
      '5 · Edit publishers',
      'Search local publisher rows by name or identifier, then open the dedicated editor. Saving changes the shared row, queues its record and republishes any edition that credits its name or identifiers. Nothing is deleted.'
    )}
  </section>
    </wa-tab-panel>

    <wa-tab-panel name="merge" active={activeTab === 'merge'}>
  <section class="section" id="merge">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h2>6 · Merge edition records</h2>
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
                      <a
                        class="admin-small"
                        href={`/admin/edition/${encodeURIComponent(record.rkey)}/edit`}
                      >
                        Edit edition
                      </a>
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
    </wa-tab-panel>

    <wa-tab-panel name="reports" active={activeTab === 'reports'}>
  <section class="section" id="reports">
    <div class="admin-content wa-stack wa-gap-l">
      <div class="wa-stack wa-gap-2xs">
        <h1>Catalog reports</h1>
        <p class="lede">
          Read-only completeness and consistency reports over the local catalog. Every edition row
          shows the canonical at-URI stored on the edition; the count covers the whole report,
          not just the current page.
        </p>
      </div>

      <wa-card with-header appearance="outlined">
        <h2 slot="header">Report and filters</h2>
        <div class="wa-stack wa-gap-m">
          {#if reportsLoading}
            <p class="muted">Loading reports…</p>
          {:else if reportsError}
            <wa-callout variant="danger">{reportsError}</wa-callout>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <wa-button
              size="small"
              onclick={() => {
                reportsLoaded = false;
                void loadReports();
              }}
            >
              Retry
            </wa-button>
          {:else if reports.length > 0}
            <div class="admin-form-grid">
              <div class="field field-grow">
                <span class="field-label">Report</span>
                <wa-select aria-label="Report" value={selectedReportId} onchange={onSelectReport}>
                  {#each reports as report (report.id)}
                    <wa-option value={report.id}>{report.title}</wa-option>
                  {/each}
                </wa-select>
              </div>
              <div class="field">
                <span class="field-label">Rows per page</span>
                <wa-select
                  aria-label="Rows per page"
                  value={String(reportLimit)}
                  onchange={(event: Event) => setReportLimit(valueOf(event))}
                >
                  <wa-option value="25">25</wa-option>
                  <wa-option value="50">50</wa-option>
                  <wa-option value="100">100</wa-option>
                </wa-select>
              </div>
              <div class="admin-form-action">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  variant="brand"
                  disabled={reportLoading}
                  onclick={() => void runReport(reportOffset)}
                >
                  {reportLoading ? 'Running…' : 'Refresh'}
                </wa-button>
              </div>
            </div>

            {#if selectedReport}
              <p class="muted admin-small">{selectedReport.description}</p>

              {#if selectedReport.params.length > 0}
                <div class="admin-form-grid">
                  {#each selectedReport.params as param (param.key)}
                    <div class="field">
                      <span class="field-label">{param.label}</span>
                      {#if param.kind === 'select'}
                        <wa-select
                          aria-label={param.label}
                          value={reportParamValues[param.key] ?? param.defaultValue}
                          onchange={(event: Event) => setReportParam(param.key, valueOf(event))}
                        >
                          {#each param.options ?? [] as option (option.value)}
                            <wa-option value={option.value}>{option.label}</wa-option>
                          {/each}
                        </wa-select>
                      {:else}
                        <wa-input
                          aria-label={param.label}
                          role="textbox"
                          tabindex="0"
                          value={reportParamValues[param.key] ?? param.defaultValue}
                          placeholder={param.placeholder ?? ''}
                          oninput={(event: Event) => setReportParam(param.key, valueOf(event))}
                          onkeydown={(event: KeyboardEvent) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void runReport(0);
                            }
                          }}
                        ></wa-input>
                      {/if}
                    </div>
                  {/each}
                  <div class="admin-form-action">
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <wa-button disabled={reportLoading} onclick={() => void runReport(0)}>
                      Apply filters
                    </wa-button>
                  </div>
                </div>
              {/if}
            {/if}
          {/if}
        </div>
      </wa-card>

      {#if reportError}
        <wa-callout variant="danger">{reportError}</wa-callout>
      {:else if selectedReport}
        <wa-card with-header appearance="outlined">
          <h2 slot="header">{selectedReport.title}</h2>
          <div class="wa-stack wa-gap-m">
            {#if reportLoading && !reportRan}
              <p class="muted">Running the report…</p>
            {:else if reportRan && reportRows.length === 0}
              <wa-callout variant="neutral">No rows match this report.</wa-callout>
            {:else if reportRows.length > 0}
              <div class="wa-cluster wa-gap-s wa-align-items-baseline">
                <span class="muted admin-small">
                  Showing {reportRangeStart}–{reportRangeEnd} of {reportTotal} row{reportTotal === 1
                    ? ''
                    : 's'}
                </span>
                {#if reportLoading}
                  <span class="muted admin-small">Refreshing…</span>
                {/if}
              </div>

              <div class="table-scroll">
                <table class="params admin-preview-table">
                  <thead>
                    <tr>
                      {#each selectedReport.columns as column (column.key)}
                        <th>{column.label}</th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each reportRows as row, index (reportRowKey(row, index))}
                      <tr>
                        {#each selectedReport.columns as column (column.key)}
                          <td>
                            {#if column.format === 'at-uri'}
                              <code class="admin-wrap admin-small">{reportText(row, column.key)}</code>
                            {:else if column.format === 'edition-list'}
                              <ul class="admin-deleted">
                                {#each reportEditions(row, column.key) as edition (edition.uri)}
                                  <li>
                                    <code class="admin-wrap admin-small">{edition.uri}</code>
                                    <span class="muted admin-small">
                                      {edition.title} · {edition.rkey}
                                    </span>
                                  </li>
                                {/each}
                              </ul>
                            {:else if column.format === 'date'}
                              <span class="admin-small">{reportDate(row[column.key])}</span>
                            {:else if column.format === 'status'}
                              <wa-tag size="small" variant="neutral">
                                {reportText(row, column.key)}
                              </wa-tag>
                            {:else}
                              <span class={column.format === 'number' ? '' : 'admin-small'}>
                                {reportText(row, column.key)}
                              </span>
                            {/if}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <div class="wa-cluster wa-gap-s">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  size="small"
                  disabled={reportLoading || reportOffset === 0}
                  onclick={() => void runReport(Math.max(0, reportOffset - reportLimit))}
                >
                  Previous
                </wa-button>
                <span class="muted admin-small">Page {reportPage} of {reportPageCount}</span>
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <wa-button
                  size="small"
                  disabled={reportLoading || reportOffset + reportRows.length >= reportTotal}
                  onclick={() => void runReport(reportOffset + reportLimit)}
                >
                  Next
                </wa-button>
              </div>
            {/if}
          </div>
        </wa-card>
      {/if}
    </div>
  </section>
    </wa-tab-panel>
  </wa-tab-group>
</main>

<style>
  .admin-tabs::part(nav) {
    padding-inline: var(--wa-space-xl);
  }

  .admin-tabs wa-tab-panel {
    --padding: 0;
  }
</style>
