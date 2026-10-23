<script lang="ts">
  import RecordCard from '$lib/components/RecordCard.svelte';
  import type { DetailValue } from '$lib/types/record-detail';
  import type { EditionWorkStatus } from '$lib/server/edition-work-votes';
  import { page } from '$app/state';

  type Candidate = { uri: string; title: string; year?: number };

  let {
    data,
    form,
  }: {
    data: {
      kind: 'editions';
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
      workStatus: EditionWorkStatus | null;
      candidates: Candidate[];
    };
    form?: { error?: string; ok?: boolean; applied?: string };
  } = $props();

  const status = $derived(data.workStatus);

  function workRkey(uri: string): string {
    return uri.split('/').pop() ?? uri;
  }

  function votesFor(uri: string): number {
    return status?.tally.links.find((l) => l.workUri === uri)?.count ?? 0;
  }

  const pendingNote = $derived.by(() => {
    if (!status) return '';
    const { decision, tally, threshold } = status;
    if (decision.action === 'link') {
      return `Consensus reached: this edition will be linked to ${workRkey(decision.workUri)}.`;
    }
    if (decision.action === 'unlink') {
      return 'Consensus reached: the work link will be removed.';
    }
    if (decision.reason === 'no-votes') {
      return 'No votes yet.';
    }
    if (decision.reason === 'already-satisfied') {
      return 'The current link already has the required support.';
    }
    const best = tally.links[0]?.count ?? 0;
    const margin = Math.abs(best - tally.unlinkCount);
    return `Waiting for consensus: net margin ${margin} of ${threshold} required.`;
  });
</script>

<main>
  <p><a href="/search">← Back to search</a></p>
  {#if data.notFound}
    <section class="missing">
      <h1>Edition not found</h1>
      <p class="muted">
        No edition record exists for rkey <code>{data.rkey}</code> at <code>{data.kind}</code>.
      </p>
    </section>
  {:else if data.value}
    <RecordCard value={data.value} />

    {#if status}
      <section class="work-link">
        <h2>Work</h2>

        {#if form?.error}
          <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">
            {form.error}
          </wa-callout>
        {:else if form?.ok}
          <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">
            Vote recorded in your repository.
          </wa-callout>
        {/if}

        <p>
          {#if status.workUri}
            Linked to
            <a href="/works/{workRkey(status.workUri)}">{workRkey(status.workUri)}</a>
            {#if status.source === 'consensus'}<span class="tag">by vote</span>
            {:else if status.source}<span class="tag">auto</span>{/if}
          {:else}
            <span class="muted">Not linked to any work.</span>
          {/if}
        </p>

        <p class="muted small">{pendingNote}</p>

        {#if status.tally.links.length > 0 || status.tally.unlinkCount > 0}
          <ul class="tally">
            {#each status.tally.links as link}
              <li>
                <code>{workRkey(link.workUri)}</code>
                <span class="count">{link.count} link</span>
              </li>
            {/each}
            {#if status.tally.unlinkCount > 0}
              <li>
                <span class="muted">unlink</span>
                <span class="count">{status.tally.unlinkCount}</span>
              </li>
            {/if}
          </ul>
        {/if}

        {#if status.myVote}
          <p class="muted small">
            Your vote:
            {#if status.myVote.action === 'link'}
              link to <code>{workRkey(status.myVote.workUri ?? '')}</code>
            {:else}
              unlink
            {/if}
          </p>
        {/if}

        {#if !page.data.viewer}
          <p class="muted small">
            <a href="/login?next={encodeURIComponent(`/editions/${data.rkey}`)}"
              >Sign in with your AT Protocol account</a
            > to vote on this edition's work.
          </p>
        {:else if data.candidates.length > 0 || status.workUri}
          <div class="actions">
            <form method="POST" action="?/linkWork" class="link-form">
              <label for="workUri">Link to a work</label>
              <select id="workUri" name="workUri" required>
                <option value="">Choose a work…</option>
                {#each data.candidates as candidate}
                  <option value={candidate.uri}>
                    {candidate.title}{candidate.year ? ` (${candidate.year})` : ''} — {workRkey(candidate.uri)}
                    {votesFor(candidate.uri) > 0 ? ` · ${votesFor(candidate.uri)} vote(s)` : ''}
                  </option>
                {/each}
                {#if status.workUri && !data.candidates.some((c) => c.uri === status.workUri)}
                  <option value={status.workUri}>
                    {workRkey(status.workUri)} (currently linked)
                  </option>
                {/if}
              </select>
              <button type="submit" class="primary">Vote to link</button>
            </form>

            {#if status.workUri}
              <form method="POST" action="?/unlinkWork">
                <button type="submit" class="secondary">Vote to unlink</button>
              </form>
            {/if}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 60rem; margin: 0 auto; }
  main > p { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-m); }
  main > p a { color: var(--wa-color-text-link); text-decoration: none; }
  main > p a:hover { text-decoration: underline; }
  .missing { padding: var(--wa-space-l) 0; }
  .missing h1 { margin: 0 0 var(--wa-space-s); }
  .muted { color: var(--wa-color-on-quiet); }
  .small { font-size: var(--wa-font-size-s); }

  .work-link {
    margin-block-start: var(--wa-space-l);
    padding: var(--wa-space-l);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
  }
  .work-link h2 { margin: 0 0 var(--wa-space-s); font-size: var(--wa-font-size-m); }
  .work-link p { margin: 0 0 var(--wa-space-s); }
  .tag {
    margin-inline-start: var(--wa-space-s);
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: 4px;
    font-size: var(--wa-font-size-xs);
    color: var(--wa-color-on-quiet);
  }
  .tally { list-style: none; padding: 0; margin: 0 0 var(--wa-space-m); display: flex; flex-wrap: wrap; gap: var(--wa-space-m); }
  .tally li { display: flex; gap: var(--wa-space-s); align-items: baseline; font-size: var(--wa-font-size-s); }
  .count { color: var(--wa-color-on-quiet); }

  .actions { display: flex; flex-wrap: wrap; gap: var(--wa-space-m); align-items: flex-end; }
  .link-form { display: flex; flex-direction: column; gap: var(--wa-space-s); }
  label { font-weight: 600; font-size: var(--wa-font-size-s); }
  select {
    min-width: 22rem;
    max-width: 100%;
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-s);
  }
  button {
    padding: var(--wa-space-s) var(--wa-space-l);
    border-radius: var(--wa-border-radius-m);
    font-weight: 600;
    font-size: var(--wa-font-size-s);
    cursor: pointer;
  }
  button.primary { border: none; background: var(--wa-color-brand-50); color: #fff; }
  button.secondary {
    border: 1px solid var(--wa-form-control-border-color);
    background: transparent;
    color: var(--wa-color-text-normal);
  }
  button:hover { filter: brightness(1.08); }
</style>
