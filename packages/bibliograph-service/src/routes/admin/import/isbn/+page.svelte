<script lang="ts">
  import "@awesome.me/webawesome/dist/components/callout/callout.js";
  import type { EditionItem, Identifier } from "$lib/server/search/types";

  let {
    data,
    form,
  }: {
    data: {
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
      results?: Record<string, EditionItem[]>;
    };
  } = $props();

  // svelte-ignore state_referenced_locally -- the form edits a copy; $effect syncs it.
  let selectedItem: EditionItem | null = $state(data.selected ?? null);
  let editTitle = $state("");
  let editSubtitle = $state("");
  let editAuthors = $state("");
  let editYear = $state("");
  let editLanguage = $state("");
  let editPublisher = $state("");
  let editDescription = $state("");
  let editCoverUrl = $state("");
  let editIdentifiers = $state("");
  let editIsbn = $state("");

  function identifierEntry(identifier: Identifier): string {
    return `${identifier.issuer}:${identifier.value}`;
  }

  function isbnOf(item: EditionItem | null): string {
    return (
      (item?.identifiers ?? []).find((i) => i.issuer === "isbn13")?.value ?? ""
    );
  }

  $effect(() => {
    if (!selectedItem) return;
    editTitle = selectedItem.title ?? "";
    editSubtitle = selectedItem.subtitle ?? "";
    editAuthors = (selectedItem.contributors ?? []).map((c) => c.name).join(", ");
    editYear = String(selectedItem.publishedYear ?? "");
    editLanguage = selectedItem.language ?? "";
    editPublisher = selectedItem.publisher?.name ?? "";
    editDescription = selectedItem.description ?? "";
    editCoverUrl = selectedItem.coverUrl ?? "";
    editIdentifiers = (selectedItem.identifiers ?? []).map(identifierEntry).join(", ");
    editIsbn = isbnOf(selectedItem);
  });

  function selectItem(item: EditionItem) {
    selectedItem = item;
    const url = new URL(window.location.href);
    url.searchParams.set("selected", JSON.stringify(item));
    window.history.replaceState({}, "", url.toString());
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
  <section style="margin-block: var(--wa-space-l);">
    <h2>Search by ISBN</h2>
    <form method="POST" action="?/search" style="display: flex; gap: var(--wa-space-s); align-items: center;">
      <input
        type="text"
        name="isbn"
        placeholder="9780140328721"
        value={data.isbnQuery ?? ""}
        style="flex: 1; padding: var(--wa-space-xs) var(--wa-space-s);"
      />
      <button type="submit" class="primary">Search</button>
    </form>
  </section>

  {#if form?.results || data.results}
    {@const res = form?.results ?? data.results ?? {}}
    <section>
      <h2>Results</h2>
      {#each ["isbndb", "google-books"] as provider}
        <div style="margin-block: var(--wa-space-m);">
          <h3 style="margin-block-end: var(--wa-space-s); text-transform: capitalize;">
            {provider.replace("-", " ")}
            <span class="muted small">({res[provider]?.length ?? 0})</span>
          </h3>
          {#if !res[provider]?.length}
            <p class="muted">No results.</p>
          {:else}
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr)); gap: var(--wa-space-s);">
              {#each res[provider] ?? [] as item}
                <article style="border: 1px solid var(--wa-border); border-radius: 8px; padding: var(--wa-space-s); background: var(--wa-surface);">
                  {#if item.coverUrl}
                    <img src={item.coverUrl} alt="" style="max-width: 4rem; border-radius: 4px; float: right; margin-left: var(--wa-space-s);" loading="lazy" />
                  {/if}
                  <h4 style="margin: 0 0 var(--wa-space-xs); font-size: 1rem;">{item.title}</h4>
                  {#if item.subtitle}<p class="muted small" style="margin: 0 0 var(--wa-space-xs);">{item.subtitle}</p>{/if}
                  <p class="muted small" style="margin: 0;">
                    {item.publishedYear ? item.publishedYear + " · " : ""}
                    {item.language ? item.language + " · " : ""}
                    {item.identifiers?.map((i) => i.issuer).join(", ")}
                  </p>
                  {#if item.description}
                    <p class="small" style="margin-top: var(--wa-space-xs); color: var(--wa-muted);">{item.description.slice(0, 200)}{item.description.length > 200 ? "…" : ""}</p>
                  {/if}
                  <button
                    type="button"
                    class="secondary"
                    style="margin-top: var(--wa-space-xs);"
                    onclick={() => selectItem(item)}
                  >Select</button>
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

        <label>
          Title <span style="color: var(--wa-error);">*</span>
          <input type="text" name="title" bind:value={editTitle} required />
        </label>
        <label>Subtitle <input type="text" name="subtitle" bind:value={editSubtitle} /></label>
        <label>Authors (comma-separated) <input type="text" name="authors" bind:value={editAuthors} /></label>
        <label>Year <input type="text" name="year" bind:value={editYear} /></label>
        <label>Language <input type="text" name="language" bind:value={editLanguage} /></label>
        <label>Publisher <input type="text" name="publisher" bind:value={editPublisher} /></label>
        <label>Pages <input type="number" name="pages" min="0" value={selectedItem.pages ?? ""} /></label>
        <label>Description <textarea name="description" rows="3" bind:value={editDescription}></textarea></label>
        <label>Identifiers (comma-separated issuer:value) <input type="text" name="identifiers" bind:value={editIdentifiers} /></label>
        <label>Cover URL <input type="text" name="coverUrl" bind:value={editCoverUrl} /></label>

        <div style="display: flex; gap: var(--wa-space-s); align-items: center; flex-wrap: wrap;">
          <button type="submit" class="primary">Import</button>
          <button type="button" onclick={() => { selectedItem = null; }} class="secondary">Cancel</button>
        </div>
      </form>

      {#if editCoverUrl}
        <img src={editCoverUrl} alt="Cover preview" style="max-width: 8rem; margin-top: var(--wa-space-s); border-radius: 4px;" loading="lazy" />
      {/if}
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
