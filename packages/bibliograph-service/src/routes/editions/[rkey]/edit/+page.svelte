<script lang="ts">
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import type { AppviewBookRow } from "$lib/server/catalog/types";
  import type { Identifier } from "$lib/server/identifiers";

  let {
    data,
    form,
  }: {
    data: { uri: string; rkey: string; row: AppviewBookRow; identifiers: Identifier[] };
    form?: { ok?: boolean; error?: string };
  } = $props();

  const row = $derived(data.row);
</script>

<main>
  <p><a href={`/editions/${data.rkey}`}>← Back to edition</a></p>
  <h1>Edit <code>{data.rkey}</code></h1>
  <p class="muted">{data.uri}</p>

  {#if form?.error}
    <wa-callout variant="danger">{form.error}</wa-callout>
  {/if}
  {#if form?.ok}
    <wa-callout variant="success">Saved.</wa-callout>
  {/if}

  <form method="POST" action="?/save" class="edit-form">
    <label>Title <input name="title" value={row.title} required /></label>
    <label>Subtitle <input name="subtitle" value={row.subtitle ?? ""} /></label>
    <label>Language <input name="language" value={row.language ?? ""} placeholder="en" /></label>
    <label>Published date <input name="publishedDate" value={row.published_date ?? ""} placeholder="2024-05-01" /></label>
    <label>Format <input name="format" value={row.format ?? ""} placeholder="hardcover" /></label>
    <label>Pages <input name="pages" type="number" min="0" value={row.pages ?? ""} /></label>
    <label>Cover URL <input name="coverUrl" value={row.cover_url ?? ""} /></label>
    <label>
      Identifiers (comma-separated <code>issuer:value</code>)
      <input
        name="identifiers"
        value={data.identifiers.map((i) => `${i.issuer}:${i.value}`).join(", ")}
        required
      />
    </label>
    <label>Description <textarea name="description" rows="5">{row.description ?? ""}</textarea></label>
    <button type="submit">Save</button>
  </form>
</main>

<style>
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: var(--wa-space-l);
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  label {
    font-weight: 600;
  }
  label input,
  label textarea {
    display: block;
    width: 100%;
    margin-top: var(--wa-space-xs);
    font-weight: 400;
  }
  .muted {
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-s);
  }
</style>
