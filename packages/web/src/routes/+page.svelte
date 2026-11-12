<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import catalog from '$lib/xrpc-catalog.json';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Stats = NonNullable<PageData['stats']>;

  let dark = $state(false);

  // Server-rendered counts are the first paint; the browser then refreshes
  // them from /api/stats while the tab is visible.
  let liveStats = $state<Stats | null>(null);
  const stats = $derived(liveStats ?? data.stats);
  const numberFormat = new Intl.NumberFormat();

  function isStats(value: unknown): value is Stats {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (['editions', 'contributors', 'publishers', 'identifiers'] as const).every(
      (key) => typeof candidate[key] === 'number'
    );
  }

  onMount(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    dark = document.documentElement.classList.contains('wa-dark');
    const sync = () => {
      if (localStorage.getItem('wa-color-scheme') === null) dark = media.matches;
    };
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  });

  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    async function refresh() {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch('/api/stats', { cache: 'no-store' });
        if (!response.ok) return;
        const next: unknown = await response.json();
        if (isStats(next)) liveStats = next;
      } catch {
        // Keep the last good counts; stats are decoration, not content.
      } finally {
        inFlight = false;
      }
    }

    function start() {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => void refresh(), 5_000);
    }

    function stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    // Poll only while visible: a hidden tab keeps its interval from running.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  function toggleTheme() {
    (window as Window & { __toggleWaColorScheme?: () => void }).__toggleWaColorScheme?.();
    dark = document.documentElement.classList.contains('wa-dark');
  }

  type Field = {
    name: string;
    type: string;
    required: boolean;
    description: string | null;
    format: string | null;
    default: unknown;
    values: string[] | null;
    minimum: number | null;
    maximum: number | null;
    maxLength: number | null;
  };
  type QueryEndpoint = { id: string; description: string; params: Field[] };
  type ProcedureEndpoint = { id: string; description: string; input: Field[]; output: Field[] };
  type RecordType = { id: string; key: string; description: string };

  const { queries, procedures, records } = catalog as unknown as {
    queries: QueryEndpoint[];
    procedures: ProcedureEndpoint[];
    records: RecordType[];
  };

  // Read-only catalog discovery is served anonymously by the edge; every other
  // procedure writes to a PDS through a DPoP session.
  const catalogLookups = new Set([
    'community.lexicon.media.book.resolveEditions',
    'community.lexicon.media.book.searchEditions'
  ]);

  const prefix = 'net.olamaelcu.livtet.biblio.';
  const shortName = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const anchor = (id: string) => id.replaceAll('.', '-');
  const requiredCount = (fields: Field[]) => fields.filter((field) => field.required).length;

  // Placeholders follow the lexicon's own constraints, so an example is a
  // shape the endpoint would actually accept.
  function sample(field: Field): unknown {
    if (field.type.startsWith('array')) {
      // A required array still needs at least one element to satisfy the
      // lexicon's non-empty bound (identifiers) or the endpoint's contract.
      if (field.type.includes('identifier')) {
        return [{ issuer: 'isbn13', value: '9780441478125' }];
      }
      if (field.type.includes('strongRef')) {
        return [{ uri: 'at://did:plc:example/collection/rkey', cid: 'bafy…' }];
      }
      return [];
    }
    if (field.type.includes('strongRef')) {
      return { uri: 'at://did:plc:example/collection/rkey', cid: 'bafy…' };
    }
    if (field.format === 'did') return 'did:plc:example';
    if (field.format === 'at-uri') return 'at://did:plc:example/collection/rkey';
    if (field.format === 'datetime') return '2026-01-01T00:00:00.000Z';
    if (field.type === 'integer' || field.type === 'number') return field.minimum ?? 1;
    if (field.values?.length) return field.values[0];
    return `${field.name}-value`;
  }

  function queryExample(endpoint: QueryEndpoint): string {
    const query = endpoint.params
      .filter((field) => field.required)
      .map((field) => `${field.name}=${String(sample(field))}`)
      .join('&');
    return `curl -s "${page.url.origin}/xrpc/${endpoint.id}${query ? `?${query}` : ''}"`;
  }

  function procedureExample(endpoint: ProcedureEndpoint): string {
    const body: Record<string, unknown> = {};
    for (const field of endpoint.input.filter((f) => f.required)) body[field.name] = sample(field);
    // searchEditions has no required field, but an empty body is InvalidQuery;
    // show the smallest body the endpoint accepts.
    if (Object.keys(body).length === 0 && endpoint.id.endsWith('searchEditions')) {
      body.title = 'The Left Hand of Darkness';
    }
    return [
      `curl -s -X POST "${page.url.origin}/xrpc/${endpoint.id}" \\`,
      "  -H 'content-type: application/json' \\",
      `  -d '${JSON.stringify(body)}'`
    ].join('\n');
  }

  function fieldNotes(field: Field): string {
    const notes: string[] = [];
    if (field.format) notes.push(field.format);
    if (field.values?.length) notes.push(field.values.join(' · '));
    if (field.default !== null) notes.push(`default ${JSON.stringify(field.default)}`);
    if (field.minimum !== null) notes.push(`min ${field.minimum}`);
    if (field.maximum !== null) notes.push(`max ${field.maximum}`);
    return notes.join(' · ');
  }
</script>

{#snippet fieldsTable(fields: Field[])}
  {#if fields.length}
    <div class="table-scroll">
      <table class="params">
        <thead>
          <tr><th>Name</th><th>Type</th><th>Required</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {#each fields as field (field.name)}
            <tr>
              <td><code>{field.name}</code></td>
              <td><code>{field.type}</code></td>
              <td>{field.required ? 'yes' : '—'}</td>
              <td>
                {field.description ?? ''}
                {#if fieldNotes(field)}
                  <br /><span class="muted">{fieldNotes(field)}</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="muted">No parameters.</p>
  {/if}
{/snippet}

{#snippet requestExample(example: string)}
  <div class="wa-cluster wa-gap-s wa-align-items-center">
    <span class="muted">Example request</span>
    <wa-copy-button value={example} copy-label="Copy request">
      <wa-icon slot="copy-icon" library="lucide" name="copy"></wa-icon>
      <wa-icon slot="success-icon" library="lucide" name="circle-check"></wa-icon>
    </wa-copy-button>
  </div>
  <pre class="code"><code>{example}</code></pre>
{/snippet}

{#snippet statCard(label: string, value: number | undefined)}
  <div class="stat-card">
    <span class="stat-value">{value === undefined ? '—' : numberFormat.format(value)}</span>
    <span class="stat-label">{label}</span>
  </div>
{/snippet}

<wa-page mobile-breakpoint="900">
  <!--
    `wa-page` inserts a node with this slot itself when it upgrades, into the
    light DOM Svelte is hydrating. Declaring it means the element reuses an
    existing node instead of inserting one mid-hydration, which otherwise
    throws `HierarchyRequestError: Cannot add children to a Text`.
  -->
  <div id="main-content" slot="skip-to-content-target"></div>
  <header slot="header" class="topbar">
    <a class="brand" href="/">
      <wa-icon library="lucide" name="circle-star"></wa-icon>
      <span class="brand-name">Bibliograph</span>
      <span class="brand-sub">net.olamaelcu.livtet.biblio</span>
    </a>
    <nav class="nav">
      <a href="#stats">Stats</a>
      <a href="#queries">Queries</a>
      <a href="#procedures">Procedures</a>
      <a href="#records">Records</a>
    </nav>
    <!-- `<wa-button>` renders a native <button> in its shadow root; the host
         listener is Svelte's wiring, so the static-element heuristics do not apply. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <wa-button
      appearance="plain"
      size="small"
      onclick={toggleTheme}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
    >
      <wa-icon library="lucide" name={dark ? 'sun' : 'moon'}></wa-icon>
    </wa-button>
  </header>

  <nav slot="navigation" class="wa-stack wa-gap-l">
    <div class="wa-stack wa-gap-2xs">
      <span class="nav-heading">Overview</span>
      <a class="nav-link" href="#overview" data-drawer="close">Introduction</a>
      <a class="nav-link" href="#stats" data-drawer="close">Stats</a>
      <a class="nav-link" href="#authentication" data-drawer="close">Authentication</a>
    </div>

    <div class="wa-stack wa-gap-2xs">
      <span class="nav-heading">Surface</span>
      <a class="nav-link" href="#queries" data-drawer="close">Queries ({queries.length})</a>
      <a class="nav-link" href="#procedures" data-drawer="close">Procedures ({procedures.length})</a>
      <a class="nav-link" href="#records" data-drawer="close">Record types ({records.length})</a>
    </div>

    <details class="nav-details">
      <summary>All queries</summary>
      <div class="wa-stack wa-gap-3xs">
        {#each queries as endpoint (endpoint.id)}
          <a class="nav-link" href={`#${anchor(endpoint.id)}`} data-drawer="close">
            {shortName(endpoint.id)}
          </a>
        {/each}
      </div>
    </details>

    <details class="nav-details">
      <summary>All procedures</summary>
      <div class="wa-stack wa-gap-3xs">
        {#each procedures as endpoint (endpoint.id)}
          <a class="nav-link" href={`#${anchor(endpoint.id)}`} data-drawer="close">
            {shortName(endpoint.id)}
          </a>
        {/each}
      </div>
    </details>
  </nav>

  <main>
    <section class="section" id="overview">
      <div class="content wa-stack wa-gap-m">
        <h1>The XRPC surface</h1>
        <p class="lede">
          The XRPC methods this service exposes: queries for reading activity, and procedures for
          catalog lookups or writes to the reader's PDS.
        </p>
        <div class="wa-cluster wa-gap-s">
          <wa-badge variant="brand">{queries.length} queries</wa-badge>
          <wa-badge variant="neutral">{procedures.length} procedures</wa-badge>
          <wa-badge variant="neutral">{records.length} record types</wa-badge>
        </div>
        <p class="muted">
          Generated from the published lexicons, so this page tracks what the service accepts.
        </p>
      </div>
    </section>

    <section class="section" id="stats">
      <div class="content stats-content wa-stack wa-gap-m">
        <h2>Stats</h2>
        <p class="muted">
          Live row counts from the catalog database. Updates every 5 seconds while this tab is
          visible.
        </p>
        {#if stats === null}
          <p class="muted">Catalog stats are unavailable right now.</p>
        {/if}
        <div class="stats-grid">
          {@render statCard('Editions', stats?.editions)}
          {@render statCard('Contributors', stats?.contributors)}
          {@render statCard('Publishers', stats?.publishers)}
          {@render statCard('Identifiers', stats?.identifiers)}
        </div>
        <p class="muted">Works are not modeled by this catalog.</p>
      </div>
    </section>

    <section class="section" id="authentication">
      <div class="content wa-stack wa-gap-m">
        <h2>Authentication</h2>

        <wa-callout variant="brand">
          <wa-icon slot="icon" library="lucide" name="user-round"></wa-icon>
          <strong>Queries are public.</strong>
          <p>No authentication is required; any caller can read.</p>
        </wa-callout>

        <wa-callout variant="warning">
          <wa-icon slot="icon" library="lucide" name="shield-check"></wa-icon>
          <strong>Write procedures need a DPoP session.</strong>
          <p>
            A procedure writes on behalf of the signed-in reader, so it requires a DPoP-bound
            session. Without one, the service answers
            <code>401 XRPC procedures require DPoP authentication</code>.
          </p>
        </wa-callout>

        <wa-callout variant="neutral">
          <wa-icon slot="icon" library="lucide" name="network"></wa-icon>
          <strong>Transport.</strong>
          <p>
            Queries are <code>GET /xrpc/&lt;nsid&gt;</code> with parameters in the query string.
            Procedures are <code>POST /xrpc/&lt;nsid&gt;</code> with a JSON body. Bodies and
            responses are JSON; failures carry <code>{'{ error, message }'}</code>.
          </p>
        </wa-callout>
      </div>
    </section>

    <section class="section" id="queries">
      <div class="content wa-stack wa-gap-l">
        <div class="wa-stack wa-gap-2xs">
          <h2>Queries</h2>
          <p class="muted">
            {queries.length} queries. No authentication required.
          </p>
        </div>

        {#each queries as endpoint (endpoint.id)}
          <wa-card with-header appearance="outlined">
            <h3 slot="header" id={anchor(endpoint.id)} class="endpoint-title">{endpoint.id}</h3>
            <div class="wa-stack wa-gap-m">
              <div class="wa-cluster wa-gap-s">
                <wa-tag variant="brand">GET</wa-tag>
                <span class="muted">
                  {requiredCount(endpoint.params)} required parameter{requiredCount(
                    endpoint.params
                  ) === 1
                    ? ''
                    : 's'}
                </span>
              </div>
              {#if endpoint.description}
                <p>{endpoint.description}</p>
              {/if}
              {@render fieldsTable(endpoint.params)}
              {@render requestExample(queryExample(endpoint))}
            </div>
          </wa-card>
        {/each}
      </div>
    </section>

    <section class="section" id="procedures">
      <div class="content wa-stack wa-gap-l">
        <div class="wa-stack wa-gap-2xs">
          <h2>Procedures</h2>
          <p class="muted">
            {procedures.length} procedures: catalog lookups are anonymous; the rest write to the
            reader's PDS and require a DPoP session.
          </p>
        </div>

        {#each procedures as endpoint (endpoint.id)}
          <wa-card with-header appearance="outlined">
            <h3 slot="header" id={anchor(endpoint.id)} class="endpoint-title">{endpoint.id}</h3>
            <div class="wa-stack wa-gap-m">
              <div class="wa-cluster wa-gap-s">
                <wa-tag variant="neutral">POST</wa-tag>
                <wa-tag variant="neutral">
                  {catalogLookups.has(endpoint.id) ? 'anonymous' : 'DPoP'}
                </wa-tag>
                <span class="muted">
                  {requiredCount(endpoint.input)} required input field{requiredCount(endpoint.input) ===
                  1
                    ? ''
                    : 's'}
                </span>
              </div>
              {#if endpoint.description}
                <p>{endpoint.description}</p>
              {/if}
              {@render fieldsTable(endpoint.input)}
              {#if endpoint.output.length}
                <div class="wa-stack wa-gap-2xs">
                  <h4>Response</h4>
                  {@render fieldsTable(endpoint.output)}
                </div>
              {/if}
              {@render requestExample(procedureExample(endpoint))}
            </div>
          </wa-card>
        {/each}
      </div>
    </section>

    <section class="section" id="records">
      <div class="content wa-stack wa-gap-m">
        <h2>Record types</h2>
        <p class="muted">
          The collections the procedures above write and the queries read.
        </p>
        <div class="table-scroll">
          <table class="params">
            <thead>
              <tr><th>Collection</th><th>Key</th><th>Purpose</th></tr>
            </thead>
            <tbody>
              {#each records as record (record.id)}
                <tr>
                  <td><code>{record.id}</code></td>
                  <td><code>{record.key}</code></td>
                  <td>{record.description}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <footer slot="footer" class="footer">
    <div class="footer-col">
      <div class="footer-head">Bibliograph</div>
      <p class="muted" style="margin: 0">
        A literary-centric AT Protocol AppView over <code>net.olamaelcu.livtet.biblio</code>.
      </p>
    </div>
    <div class="footer-col">
      <div class="footer-head">Product</div>
      <a href="/">Home</a>
      <a href="#queries">Queries</a>
      <a href="#procedures">Procedures</a>
      <a href="#records">Records</a>
    </div>
    <div class="footer-col">
      <div class="footer-head">Project</div>
      <a href="https://atproto.com/guides/glossary#app-view">AT Protocol AppView</a>
      <a href="https://atproto.com">AT Protocol</a>
    </div>
    <div class="footer-col">
      <div class="footer-head">Built by</div>
      <a href="https://www.olamaelcu.net">Olamaeclu</a>
    </div>
  </footer>
</wa-page>
