<script lang="ts">
  type Application = {
    did: string;
    handle: string | null;
    note: string | null;
    status: string;
    requestedAt: Date;
    decidedAt: Date | null;
    decidedBy: string | null;
  };

  let {
    data,
    form,
  }: {
    data: {
      pending: Application[];
      decided: Application[];
      administrators: string[];
      seniors: string[];
      viewerIsBootstrapAdmin: boolean;
    };
    form?: { error?: string; ok?: boolean };
  } = $props();

  function short(did: string): string {
    return did.length > 28 ? `${did.slice(0, 18)}…${did.slice(-6)}` : did;
  }
</script>

<main>
  <h1>Librarian queue</h1>
  <p class="lede">
    Approving issues the <code>librarian</code> label from this labeler. The label —
    not this table — is what unlocks voting.
  </p>

  {#if form?.error}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
  {:else if form?.ok}
    <wa-callout variant="success" style="margin-block-end: var(--wa-space-m)">Done.</wa-callout>
  {/if}

  <section>
    <h2>Pending ({data.pending.length})</h2>
    {#if data.pending.length === 0}
      <p class="muted">Nothing waiting for review.</p>
    {:else}
      <ul class="queue">
        {#each data.pending as row}
          <li>
            <div class="who">
              <strong>{row.handle ?? short(row.did)}</strong>
              <code class="did">{row.did}</code>
              {#if row.note}<p class="note">{row.note}</p>{/if}
              <span class="muted small">requested {row.requestedAt.toISOString().slice(0, 10)}</span>
            </div>
            <div class="decide">
              <form method="POST" action="?/approve">
                <input type="hidden" name="did" value={row.did} />
                <button type="submit" class="primary">Issue label</button>
              </form>
              <form method="POST" action="?/reject">
                <input type="hidden" name="did" value={row.did} />
                <button type="submit" class="secondary">Decline</button>
              </form>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h2>Decided ({data.decided.length})</h2>
    {#if data.decided.length === 0}
      <p class="muted">No decisions yet.</p>
    {:else}
      <ul class="queue">
        {#each data.decided as row}
          <li>
            <div class="who">
              <strong>{row.handle ?? short(row.did)}</strong>
              <code class="did">{row.did}</code>
              <span class="muted small">
                {row.status}
                {#if row.decidedAt}· {row.decidedAt.toISOString().slice(0, 10)}{/if}
              </span>
            </div>
            {#if row.status === 'approved'}
              <div class="decide">
                <form method="POST" action="?/revoke">
                  <input type="hidden" name="did" value={row.did} />
                  <button type="submit" class="secondary">Revoke label</button>
                </form>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h2>Administrators ({data.administrators.length})</h2>
    <p class="muted small">
      Holding the <code>administrator</code> label is what grants this view. The
      <code>ADMIN_DIDS</code> allowlist only bootstraps the first one.
    </p>
    {#if data.administrators.length > 0}
      <ul class="queue">
        {#each data.administrators as did}
          <li>
            <div class="who"><code class="did">{did}</code></div>
            <div class="decide">
              <form method="POST" action="?/revokeAdmin">
                <input type="hidden" name="did" value={did} />
                <button type="submit" class="secondary">Withdraw</button>
              </form>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    {#if data.viewerIsBootstrapAdmin}
      <form method="POST" action="?/grantAdmin" class="grant-form">
        <input type="text" name="did" placeholder="did:plc:…" required />
        <button type="submit" class="primary">Grant administrator</button>
      </form>
    {/if}
  </section>

  <section>
    <h2>Senior librarians ({data.seniors.length})</h2>
    <p class="muted small">
      Issued automatically by <code>pnpm labels:seniority</code> once an account has
      held the librarian label long enough and voted often enough.
    </p>
    {#if data.seniors.length > 0}
      <ul class="queue">
        {#each data.seniors as did}
          <li>
            <div class="who"><code class="did">{did}</code></div>
            <div class="decide">
              <form method="POST" action="?/revokeSenior">
                <input type="hidden" name="did" value={did} />
                <button type="submit" class="secondary">Withdraw</button>
              </form>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">Nobody qualifies yet.</p>
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
  .decide form { margin: 0; }
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
