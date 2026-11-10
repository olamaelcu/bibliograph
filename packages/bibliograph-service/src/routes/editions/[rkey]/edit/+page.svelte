<script lang="ts">
  import "@awesome.me/webawesome/dist/components/button/button.js";
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
  import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
  // Editing is a librarian-only operation; the server load already refused
  // anonymous visitors and accounts without the "librarian" label.
  // `community.lexicon.book.defs#identifier`: `type` is a global token (`isbn`)
  // or a provider domain (`goodreads.com`), `value` the namespace's own key,
  // and `url` the provider page when one is known (display-only, never compared).
  type Identifier = { type: string; value: string; url?: string };

  let {
    data,
    form,
  }: {
    data: { rkey: string; title: string; identifiers: Identifier[] };
    // SvelteKit hands back exactly what the action returned: `fail()` carries
    // `error`, success branches carry their own key.
    form?: { error?: string; backfill?: string; identifiers?: string } | null;
  } = $props();
</script>

<main>
  <nav class="crumbs">
    <a href="/search?kind=editions">Editions</a> /
    <a href="/editions/{data.rkey}">{data.title}</a> / Edit
  </nav>

  <h1>Edit edition</h1>
  <p class="lede">
    Backfills fetch cover, description, and ISBN data from upstream into this catalog row.
    Identifiers are part of the edition record itself.
  </p>

  {#if form?.error}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
  {/if}
  {#if form?.backfill}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">{form.backfill}</wa-callout>
  {/if}
  {#if form?.identifiers}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">{form.identifiers}</wa-callout>
  {/if}

  <section>
    <h2>Backfill</h2>
    <p class="muted">
      Each checked field is queued for the worker; jobs run in the background and are
      safe to repeat.
    </p>

    <form method="POST" action="?/backfill" class="panel">
      <div class="choices">
        <wa-checkbox name="cover" value="on">Cover image</wa-checkbox>
        <wa-checkbox name="description" value="on">Description</wa-checkbox>
        <wa-checkbox name="isbn" value="on">ISBN enrichment</wa-checkbox>
      </div>
      <wa-button type="submit" variant="brand">Enqueue backfill</wa-button>
    </form>
  </section>

  <section>
    <h2>Identifiers ({data.identifiers.length})</h2>
    <p class="muted">
      One per line as <code>type:value</code>: the type is a global token
      (<code>isbn</code>) or the provider's domain (<code>goodreads.com</code>),
      and the value is that namespace's own key. ISBNs are stored as hyphenless
      ISBN-13, so an ISBN-10 is converted on write. Existing identifiers are
      kept and duplicates ignored; the lexicon allows 32 in total.
    </p>

    {#if data.identifiers.length > 0}
      <ul class="pills">
        {#each data.identifiers as identifier (identifier.type + ':' + identifier.value)}
          <li>
            {#if identifier.url}
              <a href={identifier.url}><code>{identifier.value}</code></a>
            {:else}
              <code>{identifier.value}</code>
            {/if}
            <span class="res">{identifier.type}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">This edition has no identifiers yet.</p>
    {/if}

    <form method="POST" action="?/addIdentifiers" class="panel">
      <wa-textarea
        name="identifiers"
        label="Identifiers to add"
        hint="type:value, one per line — e.g. isbn:9780123456789, goodreads.com:12345"
        placeholder="isbn:9780123456789"
        rows="5"
        required
      ></wa-textarea>
      <wa-button type="submit" variant="brand">Add identifiers</wa-button>
    </form>
  </section>
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 56rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  h2 { margin: var(--wa-space-l) 0 var(--wa-space-s); font-size: var(--wa-font-size-m); }
  .crumbs { font-size: var(--wa-font-size-s); color: var(--wa-color-on-quiet); margin-block-end: var(--wa-space-s); }
  .crumbs a { color: inherit; }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-l); }
  .muted { color: var(--wa-color-on-quiet); font-size: var(--wa-font-size-s); margin: 0 0 var(--wa-space-s); }

  .panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    padding: var(--wa-space-m);
    margin-block-start: var(--wa-space-s);
  }
  .choices { display: flex; flex-direction: column; gap: var(--wa-space-xs); }
  wa-textarea { width: 100%; }

  .pills { list-style: none; padding: 0; margin: 0 0 var(--wa-space-s); display: flex; flex-wrap: wrap; gap: var(--wa-space-xs); }
  .pills li { display: flex; align-items: center; gap: 0.3rem; border: 1px solid var(--wa-form-control-border-color); border-radius: 4px; padding: 0.1rem 0.35rem; }
  .pills code { font-size: var(--wa-font-size-xs); }
  .pills a { color: var(--wa-color-text-link); text-decoration: none; }
  .pills a:hover { text-decoration: underline; }
  .res { font-size: var(--wa-font-size-xs); color: var(--wa-color-on-quiet); }
</style>
