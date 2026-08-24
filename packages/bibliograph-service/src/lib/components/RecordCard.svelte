<script lang="ts">
  import type {
    DetailValue,
    EditionValue,
    WorkValue,
    ContributorValue,
    PublisherValue,
    Identifier,
  } from '$lib/types/record-detail';
  import type { Contribution } from '$lib/types/record-detail';
  type Value = DetailValue;

  let { value }: { value: Value } = $props();

  function rkeyFromUri(uri: string): string {
    const at = uri.lastIndexOf('/');
    return at >= 0 ? uri.slice(at + 1) : uri;
  }

  function isEdition(v: Value): v is EditionValue { return v.$type === 'community.lexicon.book.edition'; }
  function isWork(v: Value): v is WorkValue { return v.$type === 'community.lexicon.book.work'; }
  function isContributor(v: Value): v is ContributorValue { return v.$type === 'community.lexicon.book.contributor'; }
  function isPublisher(v: Value): v is PublisherValue { return v.$type === 'community.lexicon.book.publisher'; }

  function identifierLabel(id: Identifier): string {
    const tail = id.uri.includes(':') ? id.uri.split(':').slice(1).join(':') : id.uri;
    return `${tail} · ${id.resource}`;
  }
</script>

{#if isEdition(value)}
  <section class="record">
    {#if value.coverImageUrl}
      <img class="cover" src={value.coverImageUrl} alt="" loading="lazy" />
    {/if}
    <header>
      <h1>{value.title}</h1>
      {#if value.subtitle}<p class="muted">{value.subtitle}</p>{/if}
    </header>
    <p class="meta">
      {#if value.publishedYear}{value.publishedYear}{/if}
      {#if value.place} · {value.place}{/if}
      {#if value.language} · {value.language}{/if}
    </p>
    {#if value.description}<p class="description">{value.description}</p>{/if}
    {#if value.contributors && value.contributors.length > 0}
      <h2>Contributors</h2>
      <ul>
        {#each value.contributors as c}
          <li>
            <code>{c.role}</code> ·
            <a href={`/contributors/${rkeyFromUri(c.subject.uri)}`}>{c.subject.uri}</a>
          </li>
        {/each}
      </ul>
    {/if}
    {#if value.identifiers && value.identifiers.length > 0}
      <h2>Identifiers</h2>
      <ul class="identifiers">
        {#each value.identifiers as id}
          <li><code>{identifierLabel(id)}</code></li>
        {/each}
      </ul>
    {/if}
  </section>
{:else if isWork(value)}
  <section class="record">
    <header>
      <h1>{value.title}</h1>
      {#if value.subtitle}<p class="muted">{value.subtitle}</p>{/if}
    </header>
    <p class="meta">
      {#if value.firstPublishedYear}first published {value.firstPublishedYear}{/if}
      {#if value.originalLanguage} · original language {value.originalLanguage}{/if}
    </p>
    {#if value.subjects && value.subjects.length > 0}
      <div class="subjects">
        {#each value.subjects as s}<wa-badge variant="brand" appearance="tint">{s}</wa-badge>{/each}
      </div>
    {/if}
    {#if value.description}<p class="description">{value.description}</p>{/if}
    {#if value.contributors && value.contributors.length > 0}
      <h2>Contributors</h2>
      <ul>
        {#each value.contributors as c}
          <li>
            <code>{c.role}</code> ·
            <a href={`/contributors/${rkeyFromUri(c.subject.uri)}`}>{c.subject.uri}</a>
          </li>
        {/each}
      </ul>
    {/if}
    {#if value.identifiers && value.identifiers.length > 0}
      <h2>Identifiers</h2>
      <ul class="identifiers">
        {#each value.identifiers as id}
          <li><code>{identifierLabel(id)}</code></li>
        {/each}
      </ul>
    {/if}
  </section>
{:else if isContributor(value)}
  <section class="record">
    <header>
      <h1>{value.name}</h1>
      {#if value.aliases && value.aliases.length > 0}
        <p class="muted">also known as {value.aliases.join(', ')}</p>
      {/if}
    </header>
    <p class="meta">
      {#if value.bornYear}b. {value.bornYear}{/if}
      {#if value.diedYear} · d. {value.diedYear}{/if}
    </p>
    {#if value.bio}<p class="description">{value.bio}</p>{/if}
    {#if value.linkedDid}
      <p class="meta">ATProto: <code><a href={`https://bsky.app/profile/${value.linkedDid}`}>{value.linkedDid}</a></code></p>
    {/if}
    {#if value.identifiers && value.identifiers.length > 0}
      <h2>Identifiers</h2>
      <ul class="identifiers">
        {#each value.identifiers as id}
          <li><code>{identifierLabel(id)}</code></li>
        {/each}
      </ul>
    {/if}
  </section>
{:else if isPublisher(value)}
  <section class="record">
    <header>
      <h1>{value.name}</h1>
    </header>
    <p class="meta">
      {#if value.foundingDate}founded {value.foundingDate}{/if}
      {#if value.closingDate} · closed {value.closingDate}{/if}
    </p>
    {#if value.imprintOf}
      <p class="meta">Imprint of <a href={`/publishers/${rkeyFromUri(value.imprintOf.uri)}`}>{value.imprintOf.uri}</a></p>
    {/if}
    {#if value.identifiers && value.identifiers.length > 0}
      <h2>Identifiers</h2>
      <ul class="identifiers">
        {#each value.identifiers as id}
          <li><code>{identifierLabel(id)}</code></li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .record {
    max-width: 50rem;
    margin: 0 auto;
    padding: var(--wa-space-l) var(--wa-space-l) var(--wa-space-l);
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-m);
  }
  .record header h1 { margin: 0 0 var(--wa-space-s); line-height: 1.12; letter-spacing: -0.02em; }
  .record header .muted { margin: 0; font-size: var(--wa-font-size-m); }
  .record .meta { color: var(--wa-color-on-quiet); margin: 0; font-size: var(--wa-font-size-s); }
  .record .description { margin: 0; line-height: 1.6; white-space: pre-line; }
  .record h2 {
    margin: var(--wa-space-m) 0 var(--wa-space-s);
    font-size: var(--wa-font-size-m);
    font-weight: 600;
  }
  .record ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }
  .subjects { display: flex; flex-wrap: wrap; gap: var(--wa-space-s); }
  .cover {
    align-self: flex-start;
    max-width: 12rem;
    border-radius: 8px;
    border: 1px solid var(--wa-form-control-border-color);
  }
  a { color: var(--wa-color-text-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
