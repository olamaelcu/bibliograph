<script lang="ts">
  import type { EditionItem } from '$lib/server/search/types';

  let {
    data,
    form,
  }: {
    data: {
      viewer?: { did: string; handle: string | null };
      isbnQuery?: string;
      results?: Record<string, EditionItem[]>;
      selected?: EditionItem | null;
    };
    form?: {
      ok?: boolean;
      editionUrl?: string;
      editionUri?: string;
      rkey?: string;
      error?: string;
      coverUrl?: string;
      results?: Record<string, EditionItem[]>;
    };
  } = $props();

  let selectedItem: EditionItem | null = $state(data.selected ?? null);
  let editTitle = $state(selectedItem?.title ?? '');
  let editSubtitle = $state(selectedItem?.subtitle ?? '');
  let editAuthors = $state((selectedItem?.contributors ?? [])
    .filter(c => c.role === 'author')
    .map(c => { if (typeof (c.subject as any)?.name === 'string') return (c.subject as any).name; return c.subject.uri; })
    .filter(Boolean)
    .join(', '));
  let editYear = $state(String(selectedItem?.publishedYear ?? ''));
  let editLanguage = $state(selectedItem?.language ?? '');
  let editPublisher = $state('');
  let editDescription = $state(selectedItem?.description ?? '');
  let editCoverUrl = $state(selectedItem?.coverImageUrl ?? '');
  let editIdentifiers = $state((selectedItem?.identifiers ?? []).map(i => i.uri).join(', '));
  let editIsbn = $state('');
  let coverSearchResult = $state('');

  $effect(() => {
    if (selectedItem) {
      editTitle = selectedItem.title ?? '';
      editSubtitle = selectedItem.subtitle ?? '';
      editAuthors = (selectedItem.contributors ?? [])
        .filter(c => c.role === 'author')
        .map(c => (c.subject as any)?.name ?? c.subject.uri)
        .filter(Boolean)
        .join(', ');
      editYear = String(selectedItem.publishedYear ?? '');
      editLanguage = selectedItem.language ?? '';
      editPublisher = '';
      editDescription = selectedItem.description ?? '';
      editCoverUrl = selectedItem.coverImageUrl ?? '';
      editIdentifiers = (selectedItem.identifiers ?? []).map(i => i.uri).join(', ');
      editIsbn = (selectedItem.identifiers ?? []).map(i => i.uri).find(uri => uri.includes('isbn')) ?? '';
    }
  });

  function selectItem(item: EditionItem, provider: string) {
    selectedItem = item;
    coverSearchResult = '';
    // Set URL param for persistence
    const url = new URL(window.location.href);
    url.searchParams.set('selected', JSON.stringify({ ...item, provider }));
    window.history.replaceState({}, '', url.toString());
  }
</script>

<main class="admin-page">
  <h1>ISBN Import</h1>
  <p class="lede">Search by ISBN across providers, edit fields, and import into the catalog.</p>

  {#if form?.error}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
  {/if}
  {#if form?.ok}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">
      Imported! <a href={form.editionUrl}>View edition</a>.
    </wa-callout>
  {/if}
  {#if form?.coverUrl}
    <wa-callout variant="info" style="margin-block-end: var(--wa-space-m)">
      Cover URL found: <a href={form.coverUrl} target="_blank" rel="noopener">{form.coverUrl}</a>
    </wa-callout>
  {/if}

  <section style="margin-block: var(--wa-space-l)">
    <h2>Search by ISBN</h2>
    <form method="POST" action="?/search" style="display: flex; gap: var(--wa-space-s); align-items: center;">
      <input
        type="text"
        name="isbn"
        placeholder="9780140328721"
        value={data.isbnQuery ?? ''}
        style="flex: 1; padding: var(--wa-space-xs) var(--wa-space-s);"
      />
      <button type="submit" class="primary">Search</button>
    </form>
  </section>

  {#if form?.results || data.results}
    {@const res = form?.results ?? data.results ?? {}}
    <section>
      <h2>Results</h2>
      {#each ['isbndb', 'google-books', 'open-library'] as provider}
        <div style="margin-block: var(--wa-space-m)">
          <h3 style="margin-block-end: var(--wa-space-s); text-transform: capitalize;">
            {provider.replace('-', ' ')}
            <span class="muted small">({res[provider]?.length ?? 0})</span>
          </h3>
          {#if !res[provider]?.length}
            <p class="muted">No results.</p>
          {:else}
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr)); gap: var(--wa-space-s);">
              {#each res[provider] ?? [] as item}
                <article style="border: 1px solid var(--wa-border); border-radius: 8px; padding: var(--wa-space-s); background: var(--wa-surface);">
                  {#if item.coverImageUrl}
                    <img src={item.coverImageUrl} alt="" style="max-width: 4rem; border-radius: 4px; float: right; margin-left: var(--wa-space-s);" loading="lazy" />
                  {/if}
                  <h4 style="margin: 0 0 var(--wa-space-xs); font-size: 1rem;">{item.title}</h4>
                  {#if item.subtitle}<p class="muted small" style="margin: 0 0 var(--wa-space-xs);">{item.subtitle}</p>{/if}
                  <p class="muted small" style="margin: 0;">
                    {item.publishedYear ? item.publishedYear + ' · ' : ''}
                    {item.language ? item.language + ' · ' : ''}
                    {item.identifiers?.map(i => i.resource).join(', ')}
                  </p>
                  {#if item.description}
                    <p class="small" style="margin-top: var(--wa-space-xs); color: var(--wa-muted);">{item.description.slice(0, 200)}{item.description.length > 200 ? '…' : ''}</p>
                  {/if}
                  <form method="POST" action="?/search" style="margin-top: var(--wa-space-xs);">
                    <input type="hidden" name="isbn" value={data.isbnQuery ?? ''} />
                    <button
                      type="submit"
                      onclick={(e) => { e.preventDefault(); selectItem(item, provider); }}
                      class="secondary"
                    >Select</button>
                  </form>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if selectedItem}
    <section style="margin-block: var(--wa-space-l); border-top: 2px solid var(--wa-border); padding-top: var(--wa-space-m);">
      <h2>Edit & Import</h2>
      <form method="POST" action="?/import" style="display: grid; gap: var(--wa-space-s); max-width: 48rem;">
        <input type="hidden" name="isbn" value={editIsbn} />
        <input type="hidden" name="selected" value={JSON.stringify({ ...selectedItem, provider: 'manual' })} />

        <label>
          Title <span style="color: var(--wa-error);">*</span>
          <input type="text" name="title" bind:value={editTitle} required />
        </label>

        <label>
          Subtitle
          <input type="text" name="subtitle" bind:value={editSubtitle} />
        </label>

        <label>
          Authors (comma-separated)
          <input type="text" name="authors" bind:value={editAuthors} />
        </label>

        <label>
          Year
          <input type="text" name="year" bind:value={editYear} />
        </label>

        <label>
          Language
          <input type="text" name="language" bind:value={editLanguage} />
        </label>

        <label>
          Publisher
          <input type="text" name="publisher" bind:value={editPublisher} />
        </label>

        <label>
          Description
          <textarea name="description" rows="3" bind:value={editDescription}></textarea>
        </label>

        <label>
          Identifiers (comma-separated URIs)
          <input type="text" name="identifiers" bind:value={editIdentifiers} />
        </label>

        <label>
          Cover URL
          <input type="text" name="coverUrl" bind:value={editCoverUrl} />
        </label>

        <div style="display: flex; gap: var(--wa-space-s); align-items: center; flex-wrap: wrap;">
          <button type="submit" class="primary">Import</button>
          <button type="button" onclick={() => { selectedItem = null; coverSearchResult = ''; }} class="secondary">Cancel</button>
        </div>
      </form>

      <div style="margin-top: var(--wa-space-s);">
        <form method="POST" action="?/coverSearch" style="display: flex; gap: var(--wa-space-xs); align-items: center;">
          <input type="hidden" name="isbn" value={editIsbn} />
          <label style="margin: 0; font-weight: normal; display: flex; gap: var(--wa-space-xs); align-items: center; width: 100%;">
            <span>Cover search:</span>
            <input type="text" name="olId" placeholder="OL cover id" bind:value={coverSearchResult} style="flex: 1;" />
            <button type="submit" class="secondary">Search cover</button>
          </label>
        </form>
        {#if editCoverUrl}
          <img src={editCoverUrl} alt="Cover preview" style="max-width: 8rem; margin-top: var(--wa-space-s); border-radius: 4px;" loading="lazy" />
        {/if}
      </div>
    </section>
  {/if}
</main>

<style>
  .admin-page { max-width: 72rem; margin: 0 auto; padding: var(--wa-space-l); }
  h1 { margin-block-end: var(--wa-space-s); }
  .lede { color: var(--wa-muted); margin-block-end: var(--wa-space-l); }
  label { display: block; font-weight: 600; }
  label input, label textarea { display: block; width: 100%; margin-top: var(--wa-space-xs); }
</style>
