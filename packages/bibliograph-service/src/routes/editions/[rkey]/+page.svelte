<script lang="ts">
  import "@awesome.me/webawesome/dist/components/badge/badge.js";
  import "@awesome.me/webawesome/dist/components/card/card.js";
  import type { EditionView } from "$lib/server/media-book-view";

  interface ReviewView {
    uri: string;
    did: string;
    record: { rating?: number; textContent?: string; createdAt?: string };
  }

  let {
    data,
    form,
  }: {
    data: {
      notFound: boolean;
      rkey: string;
      uri: string;
      edition?: EditionView;
      reviews?: ReviewView[];
      controversial?: boolean;
      isAdmin: boolean;
    };
    form?: { ok?: boolean; deleted?: boolean; backfill?: boolean; controversial?: boolean };
  } = $props();

  function authors(edition: EditionView): string {
    return edition.contributors.map((c) => c.name).join(", ");
  }

  function stars(rating: number | undefined): string {
    if (!rating) return "";
    return `★ ${(rating / 4).toFixed(1)}`;
  }
</script>

<main>
  {#if data.notFound}
    <section class="empty">
      <h1>Edition not found</h1>
      <p class="muted">No catalog record exists at <code>{data.uri}</code>.</p>
      <p><a href="/search">Search the catalog</a></p>
    </section>
  {:else if data.edition}
    {@const edition = data.edition}
    <header class="head">
      {#if edition.coverUrl}
        <img class="cover" src={edition.coverUrl} alt="" loading="lazy" />
      {/if}
      <div class="head-body">
        <h1>{edition.title}</h1>
        {#if edition.subtitle}<p class="subtitle">{edition.subtitle}</p>{/if}
        <p class="muted">{authors(edition)}</p>
        <p class="muted">
          {edition.publishedDate ?? ""}
          {#if edition.publisher?.name}· {edition.publisher.name}{/if}
          {#if edition.format}· {edition.format}{/if}
          {#if edition.pages !== undefined}· {edition.pages} pages{/if}
        </p>
        <p class="ids">
          {#each edition.identifiers as identifier}
            <wa-badge variant="neutral" appearance="tint"
              >{identifier.issuer}: {identifier.value}</wa-badge
            >
          {/each}
        </p>
        {#if data.controversial}
          <wa-badge variant="warning" appearance="filled">controversial</wa-badge>
        {/if}
      </div>
    </header>

    {#if edition.description}
      <section class="description"><p>{edition.description}</p></section>
    {/if}

    <section class="reviews">
      <h2>Reviews</h2>
      {#if !data.reviews || data.reviews.length === 0}
        <p class="muted">No reviews indexed for this edition yet.</p>
      {:else}
        {#each data.reviews as review (review.uri)}
          <wa-card>
            <div class="review-head">
              <code>{review.did}</code>
              {#if review.record.rating}
                <span class="rating">{stars(review.record.rating)}</span>
              {/if}
            </div>
            {#if review.record.textContent}
              <p>{review.record.textContent}</p>
            {/if}
          </wa-card>
        {/each}
      {/if}
    </section>

    {#if data.isAdmin}
      <section class="admin">
        <h2>Admin</h2>
        {#if form?.backfill}
          <p class="muted">Backfills queued.</p>
        {/if}
        {#if form?.deleted}
          <p class="muted">Edition deleted.</p>
        {/if}
        <form method="POST" action="?/toggleControversial">
          <button type="submit">
            {data.controversial ? "Clear" : "Apply"} controversial label
          </button>
        </form>
        <form method="POST" action="?/runBackfill">
          <button type="submit">Queue description + format backfills</button>
        </form>
        <form method="POST" action="?/deleteEdition">
          <button type="submit" class="danger">Delete edition</button>
        </form>
        <p><a href={`/editions/${data.rkey}/edit`}>Edit catalog fields</a></p>
      </section>
    {/if}
  {:else}
    <section class="empty"><p class="muted">Loading edition…</p></section>
  {/if}
</main>

<style>
  main {
    max-width: 56rem;
    margin: 0 auto;
    padding: var(--wa-space-l);
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-l);
  }
  .head {
    display: flex;
    gap: var(--wa-space-l);
    align-items: flex-start;
  }
  .cover {
    width: 10rem;
    border-radius: 8px;
    border: 1px solid var(--wa-form-control-border-color);
  }
  .head-body h1 {
    margin: 0 0 var(--wa-space-xs);
  }
  .subtitle {
    margin: 0 0 var(--wa-space-s);
    color: var(--wa-color-on-quiet);
  }
  .muted {
    color: var(--wa-color-on-quiet);
    margin: 0.15rem 0;
    font-size: var(--wa-font-size-s);
  }
  .ids {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-xs);
    margin-top: var(--wa-space-s);
  }
  .reviews {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  .review-head {
    display: flex;
    gap: var(--wa-space-s);
    align-items: center;
    margin-bottom: var(--wa-space-xs);
  }
  .rating {
    color: var(--wa-color-warning-fill-loud);
    font-weight: 600;
  }
  .admin {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
    padding-top: var(--wa-space-m);
    border-top: 1px solid var(--wa-form-control-border-color);
  }
  .admin form {
    margin: 0;
  }
  .danger {
    color: var(--wa-color-danger-fill-loud);
  }
  .empty {
    text-align: center;
  }
</style>
