<script lang="ts">
  type Item =
    | {
        $type: 'community.lexicon.book.edition';
        uri?: string;
        title: string;
        subtitle?: string;
        publishedYear?: number;
        place?: string;
        language?: string;
        coverImageUrl?: string;
      }
    | {
        $type: 'community.lexicon.book.work';
        uri?: string;
        title: string;
        subtitle?: string;
        firstPublishedYear?: number;
      }
    | {
        $type: 'community.lexicon.book.contributor';
        uri?: string;
        name: string;
      }
    | {
        $type: 'community.lexicon.book.publisher';
        uri?: string;
        name: string;
        foundingDate?: number;
        closingDate?: number;
      };

  type Kind = 'editions' | 'works' | 'contributors' | 'publishers';

  let { data }: {
    data: {
      kind: Kind;
      q?: string;
      items: Item[];
      cursor?: string;
      total?: number;
    };
  } = $props();

  const KIND_TABS: Array<{ value: Kind; label: string; endpoint: string }> = [
    { value: 'editions', label: 'Editions', endpoint: 'community.lexicon.book.edition' },
    { value: 'works', label: 'Works', endpoint: 'community.lexicon.book.work' },
    { value: 'contributors', label: 'Contributors', endpoint: 'community.lexicon.book.contributor' },
    { value: 'publishers', label: 'Publishers', endpoint: 'community.lexicon.book.publisher' },
  ];

  function isItemOfKind(item: Item, kind: Kind): boolean {
    const expect = {
      editions: 'community.lexicon.book.edition',
      works: 'community.lexicon.book.work',
      contributors: 'community.lexicon.book.contributor',
      publishers: 'community.lexicon.book.publisher',
    }[kind];
    return item.$type === expect;
  }

  function rkeyFromUri(uri?: string): string {
    if (!uri) return '';
    const at = uri.lastIndexOf('/');
    return at >= 0 ? uri.slice(at + 1) : uri;
  }

  function tabHref(kind: Kind, q?: string): string {
    const params = new URLSearchParams();
    params.set('kind', kind);
    if (q) params.set('q', q);
    return `/search?${params.toString()}`;
  }

  function heading(item: Item): string {
    if (item.$type === 'community.lexicon.book.contributor' || item.$type === 'community.lexicon.book.publisher') {
      return item.name;
    }
    return item.title;
  }

  function subtitle(item: Item): string {
    switch (item.$type) {
      case 'community.lexicon.book.edition': {
        const bits: string[] = [];
        if (item.publishedYear) bits.push(String(item.publishedYear));
        if (item.place) bits.push(item.place);
        if (item.language) bits.push(item.language);
        return bits.join(' · ');
      }
      case 'community.lexicon.book.work':
        return item.firstPublishedYear ? `first published ${item.firstPublishedYear}` : '';
      case 'community.lexicon.book.publisher': {
        const bits: string[] = [];
        if (item.foundingDate) bits.push(`founded ${item.foundingDate}`);
        if (item.closingDate) bits.push(`closed ${item.closingDate}`);
        return bits.join(' · ');
      }
      case 'community.lexicon.book.contributor':
        return '';
    }
  }
</script>

<main>
  <header class="page-intro">
    <h1>Search</h1>
    <p class="muted">
      Find bibliographic editions, works, contributors, and publishers served by Bibliograph.
    </p>
  </header>

  <form method="GET" action="/search" class="search-form">
    <input type="hidden" name="kind" value={data.kind} />
    <wa-input
      name="q"
      value={data.q ?? ''}
      placeholder="Search by title, author, or publisher…"
      label="Search query"
    ></wa-input>
    <wa-button type="submit" variant="brand">Search</wa-button>
  </form>

  <wa-button-group label="Result kind">
    {#each KIND_TABS as tab}
      <wa-button
        href={tabHref(tab.value, data.q)}
        variant={tab.value === data.kind ? 'brand' : 'default'}
        aria-current={tab.value === data.kind ? 'page' : undefined}
      >
        {tab.label}
      </wa-button>
    {/each}
  </wa-button-group>

  {#if !data.q}
    <section class="empty">
      <p>Enter a query above to search {KIND_TABS.find((t) => t.value === data.kind)?.label.toLowerCase()}.</p>
    </section>
  {:else if data.items.length === 0}
    <section class="empty">
      <p>No {KIND_TABS.find((t) => t.value === data.kind)?.label.toLowerCase()} matched <code>{data.q}</code>.</p>
    </section>
  {:else}
    <section class="results">
      {#if data.total !== undefined}
        <p class="muted meta">{data.total} match{data.total === 1 ? '' : 'es'}</p>
      {/if}
      {#each data.items as item (item.uri ?? heading(item))}
        <wa-card>
          <div slot="header" class="card-header">
            <a href={`/${data.kind}/${rkeyFromUri(item.uri)}`}>{heading(item)}</a>
            {#if item.$type === 'community.lexicon.book.edition' && item.subtitle}
              <span class="muted">— {item.subtitle}</span>
            {/if}
            {#if item.$type === 'community.lexicon.book.work' && item.subtitle}
              <span class="muted">— {item.subtitle}</span>
            {/if}
          </div>
          {#if subtitle(item)}
            <p class="muted">{subtitle(item)}</p>
          {/if}
          {#if item.$type === 'community.lexicon.book.edition' && item.coverImageUrl}
            <img src={item.coverImageUrl} alt="" class="cover" loading="lazy" />
          {/if}
        </wa-card>
      {/each}
    </section>
  {/if}
</main>

<style>
  main { display: flex; flex-direction: column; gap: var(--wa-space-m); padding: var(--wa-space-l); max-width: 900px; margin: 0 auto; }
  .page-intro h1 { margin: 0 0 var(--wa-space-s); }
  .muted { color: var(--wa-color-on-quiet); margin: 0; font-size: var(--wa-font-size-s); line-height: 1.55; }
  .meta { margin-bottom: var(--wa-space-s); }
  .search-form {
    display: flex;
    gap: var(--wa-space-s);
    align-items: end;
    flex-wrap: wrap;
  }
  .search-form wa-input { flex: 1 1 16rem; }
  .empty { padding: var(--wa-space-l); text-align: center; color: var(--wa-color-on-quiet); }
  .results { display: flex; flex-direction: column; gap: var(--wa-space-s); }
  .card-header { display: flex; gap: var(--wa-space-s); align-items: baseline; flex-wrap: wrap; }
  .card-header a { color: var(--wa-color-text-link); font-weight: 600; text-decoration: none; }
  .card-header a:hover { text-decoration: underline; }
  .cover { max-width: 8rem; border-radius: 6px; border: 1px solid var(--wa-form-control-border-color); margin-top: var(--wa-space-s); }
</style>
