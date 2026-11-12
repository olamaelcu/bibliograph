<script lang="ts">
  import { untrack } from 'svelte';
  import { parseEntityEdit, type EntityKind } from '$lib/admin/entity-edit';
  import {
    type AdminContributorRecord,
    type AdminPublisherRecord,
    type ContributorEditResponse,
    type Identifier,
    type PublisherEditResponse
  } from '$lib/admin/types';

  type EntityRecord = AdminContributorRecord | AdminPublisherRecord;

  let { kind, record }: { kind: EntityKind; record: EntityRecord } = $props();

  const initial: EntityRecord = untrack(() => record);
  // The two editor routes mount different page components, so `kind` is fixed
  // for this instance; capture it once instead of re-reading the prop.
  const entityKind: EntityKind = untrack(() => kind);
  const collection =
    entityKind === 'contributor'
      ? 'net.olamaelcu.livtet.biblio.contributor'
      : 'net.olamaelcu.livtet.biblio.publisher';
  const method = entityKind === 'contributor' ? 'getContributor' : 'getPublisher';
  const apiPath = entityKind === 'contributor' ? 'contributors' : 'publishers';
  const backHash = entityKind === 'contributor' ? 'contributors' : 'publishers';
  const label = entityKind === 'contributor' ? 'Contributor' : 'Publisher';

  type IdentifierRow = Identifier & { key: string };
  let keySeed = 0;
  function nextKey(): string {
    keySeed += 1;
    return `entity-identifier-${keySeed}`;
  }
  function identifierRows(values: Identifier[]): IdentifierRow[] {
    return values.map((identifier, index) => ({
      ...identifier,
      key: `initial-${index}-${identifier.issuer}`
    }));
  }

  let id = $state(initial.id);
  let atUri = $state(initial.atUri);
  let createdAt = $state(initial.createdAt);
  let revision = $state(initial.revision);
  let name = $state(initial.name);
  let description = $state(initial.description ?? '');
  let imageUrl = $state(initial.imageUrl ?? '');
  let identifiers = $state<IdentifierRow[]>(identifierRows(initial.identifiers));

  const contributorInitial = initial as AdminContributorRecord;
  const publisherInitial = initial as AdminPublisherRecord;
  let nameInverted = $state(
    entityKind === 'contributor' ? (contributorInitial.nameInverted ?? '') : ''
  );
  let born = $state(entityKind === 'contributor' ? (contributorInitial.born ?? '') : '');
  let died = $state(entityKind === 'contributor' ? (contributorInitial.died ?? '') : '');
  let started = $state(entityKind === 'publisher' ? (publisherInitial.started ?? '') : '');
  let ended = $state(entityKind === 'publisher' ? (publisherInitial.ended ?? '') : '');

  let baseline = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let attempted = $state(false);

  function valueOf(event: Event): string {
    const target = event.currentTarget as EventTarget & { value?: unknown };
    return typeof target.value === 'string' ? target.value : '';
  }

  function valueOrNull(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  function usedIdentifiers(): Identifier[] {
    return identifiers
      .filter((row) => row.issuer.trim() !== '' || row.value.trim() !== '')
      .map((row) => ({ issuer: row.issuer.trim(), value: row.value.trim() }));
  }

  function buildPayload(): Record<string, unknown> {
    const base = {
      name,
      identifiers: usedIdentifiers(),
      description: valueOrNull(description),
      imageUrl: valueOrNull(imageUrl),
      expectedRevision: revision
    };
    if (entityKind === 'contributor') {
      return {
        ...base,
        nameInverted: valueOrNull(nameInverted),
        born: valueOrNull(born),
        died: valueOrNull(died)
      };
    }
    return {
      ...base,
      started: valueOrNull(started),
      ended: valueOrNull(ended)
    };
  }

  const issues = $derived(parseEntityEdit(entityKind, buildPayload()).errors);
  const dirty = $derived(JSON.stringify(buildPayload()) !== baseline);
  const valid = $derived(issues.length === 0);

  function fieldError(path: string): string | null {
    return issues.find((issue) => issue.path === path)?.message ?? null;
  }

  function sectionErrors(prefix: string): string[] {
    return issues
      .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
      .map((issue) => (issue.path === prefix ? issue.message : `${issue.path}: ${issue.message}`));
  }

  function addIdentifier() {
    identifiers.push({ key: nextKey(), issuer: '', value: '' });
  }

  function removeIdentifier(key: string) {
    const index = identifiers.findIndex((row) => row.key === key);
    if (index >= 0) identifiers.splice(index, 1);
  }

  function applyRecord(next: EntityRecord) {
    id = next.id;
    atUri = next.atUri;
    createdAt = next.createdAt;
    revision = next.revision;
    name = next.name;
    description = next.description ?? '';
    imageUrl = next.imageUrl ?? '';
    identifiers = identifierRows(next.identifiers);
    if (entityKind === 'contributor') {
      const contributor = next as AdminContributorRecord;
      nameInverted = contributor.nameInverted ?? '';
      born = contributor.born ?? '';
      died = contributor.died ?? '';
    } else {
      const publisher = next as AdminPublisherRecord;
      started = publisher.started ?? '';
      ended = publisher.ended ?? '';
    }
    baseline = JSON.stringify(buildPayload());
  }

  async function responseError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    } catch {
      // Fall through to the status text.
    }
    return `Request failed (${response.status})`;
  }

  async function save() {
    attempted = true;
    saveError = null;
    notice = null;
    if (!valid) {
      saveError = 'Fix the highlighted fields before saving.';
      return;
    }
    if (!dirty) return;
    saving = true;
    try {
      const response = await fetch(`/admin/api/${apiPath}/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload())
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as ContributorEditResponse | PublisherEditResponse;
      applyRecord('contributor' in body ? body.contributor : body.publisher);
      notice =
        atUri === null
          ? 'Saved. This row has no at-URI yet, so no record was queued; the entities.prepare task mints addresses for existing rows.'
          : 'Saved. The catalog triggers queued this record for publication and any edition that credits its name or identifiers.';
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'The save failed.';
    } finally {
      saving = false;
    }
  }

  baseline = JSON.stringify(buildPayload());

  // A client-side navigation between two editor URLs reuses this component;
  // reset only when the loaded row itself changes, never on invalidate.
  $effect(() => {
    if (record.id !== id || record.atUri !== atUri) applyRecord(record);
  });

</script>

{#snippet identifierEditor()}
  <div class="identifier-list">
    {#each identifiers as row (row.key)}
      <div class="identifier-row">
        <wa-input
          aria-label="Identifier issuer"
          value={row.issuer}
          placeholder="issuer (e.g. isni)"
          oninput={(event: Event) => (row.issuer = valueOf(event))}
        ></wa-input>
        <wa-input
          aria-label="Identifier value"
          value={row.value}
          placeholder="value"
          oninput={(event: Event) => (row.value = valueOf(event))}
        ></wa-input>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <wa-button
          size="small"
          appearance="plain"
          aria-label={`Remove identifier ${row.issuer || row.value || 'row'}`}
          onclick={() => removeIdentifier(row.key)}
        >
          Remove
        </wa-button>
      </div>
    {/each}
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <wa-button size="small" appearance="outlined" onclick={addIdentifier}>
    Add identifier
  </wa-button>
{/snippet}

<main class="admin-main">
  <div class="admin-content wa-stack wa-gap-l editor-shell">
    <div class="editor-heading">
      <div class="wa-stack wa-gap-2xs">
        <a class="admin-small" href={`/admin#${backHash}`}>← Back to catalog curation</a>
        <h1>Edit {entityKind}</h1>
        <span class="muted admin-wrap">{atUri ?? 'No at-URI minted yet'}</span>
        <span class="muted admin-small">
          id <code>{id}</code> · created {new Date(createdAt).toISOString()}
        </span>
      </div>
      {#if dirty}
        <wa-badge variant="warning">Unsaved changes</wa-badge>
      {:else}
        <wa-badge variant="neutral">Saved</wa-badge>
      {/if}
    </div>

    {#if saveError}
      <wa-callout variant="danger">{saveError}</wa-callout>
    {/if}
    {#if notice}
      <wa-callout variant="success">{notice}</wa-callout>
    {/if}
    {#if attempted && !valid}
      <wa-callout variant="warning">
        <div class="wa-stack wa-gap-2xs">
          <strong>This record is not ready to save.</strong>
          <ul class="issue-list">
            {#each issues as issue (issue.path + issue.message)}
              <li>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>
            {/each}
          </ul>
        </div>
      </wa-callout>
    {/if}

    <wa-card with-header appearance="outlined">
      <h2 slot="header">Record identity (read-only)</h2>
      <dl class="entity-meta">
        <div>
          <dt>id</dt>
          <dd><code>{id}</code></dd>
        </div>
        <div>
          <dt>Canonical AT URI</dt>
          <dd><code class="admin-wrap">{atUri ?? '— not minted —'}</code></dd>
        </div>
        <div>
          <dt>Record URL</dt>
          <dd>
            {#if atUri}
              <a
                class="admin-small admin-wrap"
                href={`/xrpc/net.olamaelcu.livtet.biblio.${method}?uri=${encodeURIComponent(atUri)}`}
              >
                /xrpc/net.olamaelcu.livtet.biblio.{method}
              </a>
            {:else}
              <span class="muted admin-small">Not available until an at-URI exists</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(createdAt).toISOString()}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd><code class="admin-wrap admin-small">{revision}</code></dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd><code class="admin-wrap admin-small">{collection}</code></dd>
        </div>
      </dl>
    </wa-card>

    <wa-card with-header appearance="outlined">
      <h2 slot="header">{label} fields</h2>
      <div class="wa-stack wa-gap-m">
        <div class="editor-grid">
          <div class="field editor-span-2">
            <span class="field-label">
              {entityKind === 'contributor' ? 'Name / display name' : 'Name'}
            </span>
            <wa-input
              aria-label={entityKind === 'contributor' ? 'Name / display name' : 'Name'}
              value={name}
              placeholder={entityKind === 'contributor' ? 'Frank Herbert' : 'Ace Books'}
              oninput={(event: Event) => (name = valueOf(event))}
            ></wa-input>
            {#if fieldError('name')}
              <span class="field-error">{fieldError('name')}</span>
            {/if}
          </div>

          {#if entityKind === 'contributor'}
            <div class="field editor-span-2">
              <span class="field-label">Inverted name (optional)</span>
              <wa-input
                aria-label="Inverted name"
                value={nameInverted}
                placeholder="Herbert, Frank"
                oninput={(event: Event) => (nameInverted = valueOf(event))}
              ></wa-input>
              {#if fieldError('nameInverted')}
                <span class="field-error">{fieldError('nameInverted')}</span>
              {/if}
            </div>
          {/if}
        </div>

        <div class="field">
          <span class="field-label">Identifiers (optional)</span>
          {@render identifierEditor()}
          {#if sectionErrors('identifiers').length > 0}
            <span class="field-error">{sectionErrors('identifiers').join(' · ')}</span>
          {/if}
        </div>

        <div class="field">
          <span class="field-label">Description (optional)</span>
          <wa-textarea
            aria-label="Description"
            rows="5"
            value={description}
            oninput={(event: Event) => (description = valueOf(event))}
          ></wa-textarea>
          {#if fieldError('description')}
            <span class="field-error">{fieldError('description')}</span>
          {/if}
        </div>

        <div class="editor-grid">
          <div class="field">
            <span class="field-label">Image URL (http or https, optional)</span>
            <wa-input
              aria-label="Image URL"
              value={imageUrl}
              placeholder="https://example.org/portrait.jpg"
              oninput={(event: Event) => (imageUrl = valueOf(event))}
            ></wa-input>
            {#if fieldError('imageUrl')}
              <span class="field-error">{fieldError('imageUrl')}</span>
            {/if}
          </div>

          {#if entityKind === 'contributor'}
            <div class="field">
              <span class="field-label">Born (YYYY-MM-DD, optional)</span>
              <wa-input
                aria-label="Born"
                value={born}
                placeholder="1920-10-08"
                oninput={(event: Event) => (born = valueOf(event))}
              ></wa-input>
              {#if fieldError('born')}
                <span class="field-error">{fieldError('born')}</span>
              {/if}
            </div>
            <div class="field">
              <span class="field-label">Died (YYYY-MM-DD, optional)</span>
              <wa-input
                aria-label="Died"
                value={died}
                placeholder="1986-02-11"
                oninput={(event: Event) => (died = valueOf(event))}
              ></wa-input>
              {#if fieldError('died')}
                <span class="field-error">{fieldError('died')}</span>
              {/if}
            </div>
          {:else}
            <div class="field">
              <span class="field-label">Started (YYYY-MM-DD, optional)</span>
              <wa-input
                aria-label="Started"
                value={started}
                placeholder="1972-01-01"
                oninput={(event: Event) => (started = valueOf(event))}
              ></wa-input>
              {#if fieldError('started')}
                <span class="field-error">{fieldError('started')}</span>
              {/if}
            </div>
            <div class="field">
              <span class="field-label">Ended (YYYY-MM-DD, optional)</span>
              <wa-input
                aria-label="Ended"
                value={ended}
                placeholder="1998-12-31"
                oninput={(event: Event) => (ended = valueOf(event))}
              ></wa-input>
              {#if fieldError('ended')}
                <span class="field-error">{fieldError('ended')}</span>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </wa-card>

    <div class="editor-actions">
      <span class="muted admin-small">
        Editing this row changes the shared catalog record. Nothing is deleted.
      </span>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <wa-button
        variant="brand"
        disabled={saving || (!dirty && valid)}
        onclick={() => void save()}
      >
        {saving ? 'Saving…' : `Save ${entityKind}`}
      </wa-button>
    </div>
  </div>
</main>

<style>
  .editor-shell {
    padding-block: var(--wa-space-l) var(--wa-space-2xl);
  }

  .editor-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
  }

  .editor-heading h1 {
    margin: 0;
  }

  .editor-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--wa-space-m);
  }

  .editor-span-2 {
    grid-column: span 2;
  }

  .field-error {
    color: var(--wa-color-danger-border-loud, var(--wa-color-danger-text));
    font-size: var(--wa-font-size-xs);
  }

  .issue-list {
    margin: 0;
    padding-inline-start: var(--wa-space-l);
    font-size: var(--wa-font-size-xs);
  }

  .identifier-list {
    display: grid;
    gap: var(--wa-space-2xs);
  }

  .identifier-row {
    display: grid;
    grid-template-columns: minmax(8rem, 0.8fr) minmax(12rem, 1.4fr) auto;
    gap: var(--wa-space-xs);
    align-items: center;
  }

  .entity-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--wa-space-m);
    margin: 0;
  }

  .entity-meta dt {
    color: var(--wa-color-text-quiet);
    font-size: var(--wa-font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .entity-meta dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-m);
    flex-wrap: wrap;
    padding: var(--wa-space-m);
    border: var(--wa-border-width-s) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
    position: sticky;
    bottom: var(--wa-space-s);
    z-index: 2;
  }

  @media (max-width: 900px) {
    .editor-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .editor-span-2 {
      grid-column: auto;
    }
  }

  @media (max-width: 640px) {
    .identifier-row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
