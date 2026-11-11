<script lang="ts">
  import "@awesome.me/webawesome/dist/components/button/button.js";
  import "@awesome.me/webawesome/dist/components/card/card.js";
  import "@awesome.me/webawesome/dist/components/input/input.js";
  import type { BookView } from "$lib/server/media-book-view";

  let {
    data,
  }: {
    data: { q: string; items: BookView[]; total: number };
  } = $props();

  function rkeyFromUri(uri: string): string {
    const at = uri.lastIndexOf("/");
    return at >= 0 ? uri.slice(at + 1) : uri;
  }

  function authors(item: BookView): string {
    return item.edition.contributors.map((c) => c.name).join(", ");
  }
</script>

<main>
  <header class="page-intro">
    <h1>Search</h1>
    <p class="muted">
      Find catalog editions served by Bibliograph. Matching is exact on identifiers
      and substring on title; the same catalog backs the
      <code>community.lexicon.media.book.searchEditions</code> procedure.
    </p>
  </header>

  <form method="GET" action="/search" class="search-form">
    <wa-input
      name="q"
      value={data.q}
      placeholder="Search by title…"
      label="Search query"
    ></wa-input>
    <wa-button type="submit" variant="brand">Search</wa-button>
  </form>

  {#if !data.q}
    <section class="empty"><p>Enter a query above.</p></section>
  {:else if data.items.length === 0}
    <section class="empty">
      <p>No editions matched <code>{data.q}</code>.</p>
    </section>
  {:else}
    <section class="results">
      <p class="muted meta">{data.total} match{data.total === 1 ? "" : "es"}</p>
      {#each data.items as item (item.uri)}
        <wa-card>
          <div class="result">
            {#if item.edition.coverUrl}
              <img class="thumb" src={item.edition.coverUrl} alt="" loading="lazy" />
            {/if}
            <div class="result-body">
              <div class="card-header">
                <a href={`/editions/${rkeyFromUri(item.uri)}`}>{item.edition.title}</a>
                {#if item.edition.subtitle}
                  <span class="muted">— {item.edition.subtitle}</span>
                {/if}
              </div>
              {#if authors(item)}
                <p class="muted">{authors(item)}</p>
              {/if}
              <p class="muted">
                {item.edition.publishedDate ?? ""}
                {#if item.edition.publisher?.name}
                  · {item.edition.publisher.name}
                {/if}
                {#if item.edition.identifiers.length > 0}
                  · {item.edition.identifiers.map((i) => `${i.issuer}:${i.value}`).join(", ")}
                {/if}
              </p>
            </div>
          </div>
        </wa-card>
      {/each}
    </section>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-m);
    padding: var(--wa-space-l);
    max-width: 900px;
    margin: 0 auto;
  }
  .page-intro h1 {
    margin: 0 0 var(--wa-space-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
    margin: 0;
    font-size: var(--wa-font-size-s);
    line-height: 1.55;
  }
  .search-form {
    display: flex;
    gap: var(--wa-space-s);
    align-items: end;
    flex-wrap: wrap;
  }
  .search-form wa-input {
    flex: 1 1 16rem;
  }
  .empty {
    padding: var(--wa-space-l);
    text-align: center;
    color: var(--wa-color-on-quiet);
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  .result {
    display: flex;
    gap: var(--wa-space-s);
    align-items: flex-start;
  }
  .card-header {
    display: flex;
    gap: var(--wa-space-s);
    align-items: baseline;
    flex-wrap: wrap;
  }
  .card-header a {
    color: var(--wa-color-text-link);
    font-weight: 600;
    text-decoration: none;
  }
  .card-header a:hover {
    text-decoration: underline;
  }
  .result-body {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
    min-width: 0;
  }
  .thumb {
    flex: 0 0 auto;
    width: 4rem;
    height: 6rem;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--wa-form-control-border-color);
  }
</style>
