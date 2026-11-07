<script lang="ts">
  type Librarian = {
    did: string;
    handle: string | null;
    note: string | null;
    decidedAt: Date | null;
    decidedBy: string | null;
  };

  let {
    data,
    form,
  }: {
    data: { librarians: Librarian[] };
    form?: { error?: string; ok?: boolean };
  } = $props();

  function short(did: string): string {
    return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-6)}` : did;
  }
</script>

<main>
  <h1>Librarians</h1>
  <p class="lede">
    The <code>librarian</code> label is the credential that unlocks curation. Issue
    it directly to any account here, or revoke an existing one; the label stream —
    not a database flag — is what every gate reads.
  </p>

  {#if form?.error}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
  {:else if form?.ok}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">Done.</wa-callout>
  {/if}

  <section>
    <h2>Issue a label</h2>
    <form method="POST" action="?/issue" class="grant-form">
      <input
        type="text"
        name="account"
        placeholder="did:plc:… or alice.bsky.social"
        aria-label="Account DID or handle"
        required
      />
      <input type="text" name="note" placeholder="Why (optional)" aria-label="Note" />
      <button type="submit" class="primary">Issue librarian label</button>
    </form>
    <p class="muted small">
      A handle is resolved to its DID before the label is signed; an unresolvable
      account is reported instead of granted. Re-issuing to an existing librarian
      simply refreshes the label.
    </p>
  </section>

  <section>
    <h2>Current librarians ({data.librarians.length})</h2>
    {#if data.librarians.length === 0}
      <p class="muted">Nobody holds the librarian label yet.</p>
    {:else}
      <ul class="queue">
        {#each data.librarians as row}
          <li>
            <div class="who">
              <strong>{row.handle ?? short(row.did)}</strong>
              <code class="did">{row.did}</code>
              {#if row.note}<p class="note">{row.note}</p>{/if}
              {#if row.decidedAt}
                <span class="muted small">
                  granted {row.decidedAt.toISOString().slice(0, 10)}
                  {#if row.decidedBy}by {short(row.decidedBy)}{/if}
                </span>
              {/if}
            </div>
            <div class="decide">
              <form method="POST" action="?/revoke">
                <input type="hidden" name="did" value={row.did} />
                <button type="submit" class="secondary">Revoke label</button>
              </form>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 56rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  h2 { font-size: var(--wa-font-size-m); margin: var(--wa-space-l) 0 var(--wa-space-s); }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-l); }
  .muted { color: var(--wa-color-on-quiet); }
  .small { font-size: var(--wa-font-size-s); }

  .queue { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--wa-space-s); }
  .queue li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-m);
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
  }
  .who { display: flex; flex-direction: column; gap: 0.2rem; min-width: 18rem; }
  .did { font-size: var(--wa-font-size-xs); color: var(--wa-color-on-quiet); }
  .note { margin: 0.25rem 0; font-size: var(--wa-font-size-s); }
  .decide { display: flex; gap: var(--wa-space-s); }
  .decide form { margin: 0; }
  .grant-form { display: flex; flex-wrap: wrap; gap: var(--wa-space-s); margin-block-start: var(--wa-space-m); }
  .grant-form input {
    min-width: 22rem;
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-s);
  }
  button {
    padding: var(--wa-space-s) var(--wa-space-m);
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
</style>
