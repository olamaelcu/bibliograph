<script lang="ts">
  type MergedRow = {
    uri: string;
    title: string;
    identifiers: Array<{ uri: string; resource: string }>;
    contributors: Array<{ subject: { uri: string; cid: string }; role: string }>;
    coverImageUrl: string | null;
    description: string | null;
  };

  let {
    form,
  }: {
    form?:
      | { error: string }
      | { merged: MergedRow; deleted: string[] };
  } = $props();
</script>

<main>
  <nav class="crumbs"><a href="/admin">Admin</a> / Edition merge</nav>
  <h1>Merge editions</h1>
  <p class="lede">
    Pick the edition to <strong>keep</strong> — it keeps its URI, which is what every link
    and join points at — and the duplicates to fold into it. Identifiers and contributors
    are unioned; the duplicates are then deleted from this catalog.
  </p>

  {#if form && 'error' in form}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
  {:else if form}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">
      Merged {form.deleted.length} {form.deleted.length === 1 ? 'edition' : 'editions'} into
      <a href="/editions/{form.merged.uri.split('/').pop()}">{form.merged.title}</a>.
    </wa-callout>

    <section>
      <h2>Resulting row</h2>
      <dl class="facts">
        <dt>URI</dt>
        <dd><code>{form.merged.uri}</code></dd>
        <dt>Identifiers ({form.merged.identifiers.length})</dt>
        <dd>
          {#if form.merged.identifiers.length === 0}
            <span class="muted">none</span>
          {:else}
            {#each form.merged.identifiers as identifier}
              <code class="pill">{identifier.resource}:{identifier.uri}</code>
            {/each}
          {/if}
        </dd>
        <dt>Contributors ({form.merged.contributors.length})</dt>
        <dd>
          {#if form.merged.contributors.length === 0}
            <span class="muted">none</span>
          {:else}
            {#each form.merged.contributors as contributor}
              <code class="pill">{contributor.role}: {contributor.subject.uri.split('/').pop()}</code>
            {/each}
          {/if}
        </dd>
        <dt>Cover</dt>
        <dd>
          {#if form.merged.coverImageUrl}
            <code>{form.merged.coverImageUrl}</code>
          {:else}
            <span class="muted">cleared</span>
          {/if}
        </dd>
        <dt>Description</dt>
        <dd>
          {#if form.merged.description}
            {form.merged.description}
          {:else}
            <span class="muted">cleared</span>
          {/if}
        </dd>
      </dl>
    </section>

    <section>
      <h2>Deleted ({form.deleted.length})</h2>
      <ul class="deleted">
        {#each form.deleted as uri}
          <li><code>{uri}</code></li>
        {/each}
      </ul>
    </section>
  {/if}

  <form method="POST" action="?/merge" class="merge">
    <label class="field">
      <span class="label">Edition to keep</span>
      <input
        type="text"
        name="primaryUri"
        required
        placeholder="at://did:web:…/community.lexicon.book.edition/ol.OL1M"
      />
    </label>

    <label class="field">
      <span class="label">Editions to merge into it</span>
      <textarea
        name="otherUris"
        rows="4"
        required
        placeholder={'One at:// URI per line\nat://did:web:…/community.lexicon.book.edition/ol.OL2N'}
      ></textarea>
      <span class="hint">Duplicate URIs are ignored; every URI must already exist here.</span>
    </label>

    <fieldset class="field">
      <legend class="label">Cover</legend>
      <label class="choice"><input type="radio" name="coverImageUrlMode" value="keep" checked /> Keep the winner's cover</label>
      <label class="choice"><input type="radio" name="coverImageUrlMode" value="clear" /> Clear the cover</label>
      <label class="choice"><input type="radio" name="coverImageUrlMode" value="replace" /> Use this URL</label>
      <input type="url" name="coverImageUrl" placeholder="https://…" />
    </fieldset>

    <fieldset class="field">
      <legend class="label">Description</legend>
      <label class="choice"><input type="radio" name="descriptionMode" value="keep" checked /> Keep the winner's description</label>
      <label class="choice"><input type="radio" name="descriptionMode" value="clear" /> Clear the description</label>
      <label class="choice"><input type="radio" name="descriptionMode" value="replace" /> Use this text</label>
      <textarea name="description" rows="3" placeholder="Chosen description"></textarea>
    </fieldset>

    <button type="submit" class="primary">Merge and delete the duplicates</button>
    <p class="hint">
      The ATProto records these rows were ingested from are untouched: this is local
      catalog curation, and a full re-ingest would recreate the merged rows.
    </p>
  </form>
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 56rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  h2 { font-size: var(--wa-font-size-m); margin: var(--wa-space-l) 0 var(--wa-space-s); }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-l); }
  .crumbs { font-size: var(--wa-font-size-s); color: var(--wa-color-on-quiet); margin-block-end: var(--wa-space-s); }
  .crumbs a { color: inherit; }
  .muted { color: var(--wa-color-on-quiet); }
  .hint { display: block; color: var(--wa-color-on-quiet); font-size: var(--wa-font-size-xs); margin-block-start: var(--wa-space-xs); }

  .merge { display: flex; flex-direction: column; gap: var(--wa-space-m); }
  .field { display: flex; flex-direction: column; gap: 0.35rem; border: 0; padding: 0; margin: 0; }
  .label { font-weight: 600; font-size: var(--wa-font-size-s); }
  .choice { display: flex; align-items: center; gap: 0.4rem; font-size: var(--wa-font-size-s); }

  .merge input[type='text'],
  .merge input[type='url'],
  .merge textarea {
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-s);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  button {
    align-self: flex-start;
    padding: var(--wa-space-s) var(--wa-space-m);
    border-radius: var(--wa-border-radius-m);
    font-weight: 600;
    font-size: var(--wa-font-size-s);
    cursor: pointer;
  }
  button.primary { border: none; background: var(--wa-color-brand-50); color: #fff; }

  .facts { display: grid; grid-template-columns: 12rem 1fr; gap: 0.5rem var(--wa-space-m); margin: 0; }
  .facts dt { font-weight: 600; font-size: var(--wa-font-size-s); }
  .facts dd { margin: 0; font-size: var(--wa-font-size-s); display: flex; flex-wrap: wrap; gap: var(--wa-space-xs); }
  .pill { border: 1px solid var(--wa-form-control-border-color); border-radius: 4px; padding: 0.1rem 0.35rem; }

  .deleted { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .deleted code { font-size: var(--wa-font-size-xs); color: var(--wa-color-on-quiet); }
</style>
