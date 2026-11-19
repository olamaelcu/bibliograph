<script lang="ts">
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  /** A claim row's timestamp, as a person reads it. */
  function when(value: string | null): string {
    if (value === null) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }
</script>

<svelte:head>
  <title>Contributor claims — librarians</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="claims">
  <header class="claims-header">
    <div>
      <h1>Contributor claims</h1>
      <p class="muted">
        Signed in as <code>{data.did}</code>. Approving a claim links the account to
        the contributor record permanently and issues the <code>known-author</code>
        label; rejecting records the refusal and issues nothing.
      </p>
    </div>
    <form method="POST" action="/librarian/logout">
      <wa-button type="submit" appearance="outlined" size="small">Sign out</wa-button>
    </form>
  </header>

  {#if !data.workerOk}
    <wa-callout variant="warning">
      The worker admin API did not answer, so this queue may be incomplete. The
      catalog writes it owns (and the label queue behind them) are unaffected.
    </wa-callout>
  {/if}

  {#if form?.message}
    <wa-callout variant="danger">{form.message}</wa-callout>
  {/if}

  <section aria-labelledby="pending-heading">
    <h2 id="pending-heading">Awaiting a decision ({data.pending.length})</h2>

    {#if data.pending.length === 0}
      <p class="muted">No undecided claims.</p>
    {:else}
      <ul class="claim-list">
        {#each data.pending as claim (claim.uri)}
          <li>
            <wa-card appearance="outlined">
              <div class="wa-stack wa-gap-s">
                <div class="claim-head">
                  <a href="https://bsky.app/profile/{claim.did}" target="_blank" rel="external noopener noreferrer">
                    <code>{claim.did}</code>
                  </a>
                  <span class="muted">{when(claim.createdAt)}</span>
                </div>

                <p class="claim-target">
                  Claims to be
                  {#if claim.name && claim.contributorAtUri}
                    <strong><a href="/xrpc/net.olamaelcu.livtet.biblio.getContributor?uri={encodeURIComponent(claim.contributorAtUri)}">{claim.name}</a></strong>
                  {:else}
                    <strong>{claim.contributorUri ?? 'an unknown contributor'}</strong>
                  {/if}
                  {#if claim.contributorUri}
                    <br /><code class="muted">{claim.contributorUri}</code>
                  {/if}
                </p>

                {#if claim.message}
                  <blockquote class="claim-message">{claim.message}</blockquote>
                {/if}

                {#if claim.contributorUri === null}
                  <p class="muted">
                    The catalog has no contributor with that URI, so approving it
                    would fail; reject the claim instead.
                  </p>
                {/if}

                <form method="POST" class="wa-stack wa-gap-xs">
                  <input type="hidden" name="claimUri" value={claim.uri} />
                  <input type="hidden" name="subjectDid" value={claim.did} />
                  <input type="hidden" name="contributorUri" value={claim.contributorUri ?? ''} />
                  <label class="field">
                    <span class="field-label">Note (optional)</span>
                    <input type="text" name="note" maxlength="512" />
                  </label>
                  <div class="wa-cluster wa-gap-s">
                    <wa-button
                      type="submit"
                      formaction="?/approve"
                      variant="brand"
                      disabled={claim.contributorUri === null}>Approve</wa-button
                    >
                    <wa-button type="submit" formaction="?/reject" appearance="outlined">Reject</wa-button>
                  </div>
                </form>
              </div>
            </wa-card>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="verified-heading">
    <h2 id="verified-heading">Verified accounts ({data.identities.length})</h2>

    {#if data.identities.length === 0}
      <p class="muted">No contributor has a verified account yet.</p>
    {:else}
      <ul class="claim-list">
        {#each data.identities as identity (identity.did)}
          <li>
            <wa-card appearance="outlined">
              <div class="wa-stack wa-gap-s">
                <div class="claim-head">
                  <a href="https://bsky.app/profile/{identity.did}" target="_blank" rel="external noopener noreferrer">
                    <code>{identity.did}</code>
                  </a>
                  <span class="muted">{when(identity.createdAt)}</span>
                </div>
                <p class="claim-target">
                  Verified as <strong>{identity.name}</strong><br />
                  <code class="muted">{identity.contributor}</code>
                </p>
                {#if identity.issuedBy}
                  <p class="muted admin-small">Approved by <code>{identity.issuedBy}</code></p>
                {/if}
                <form method="POST" action="?/revoke">
                  <input type="hidden" name="did" value={identity.did} />
                  <wa-button type="submit" appearance="outlined" size="small"
                    >Revoke</wa-button
                  >
                </form>
              </div>
            </wa-card>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>

<style>
  .claims {
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--wa-space-l) var(--wa-space-l) var(--wa-space-2xl);
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-l);
  }

  .claims-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--wa-space-m);
  }

  .claims-header h1 {
    margin: 0 0 var(--wa-space-2xs);
    font-size: var(--wa-font-size-xl);
  }

  .claim-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-s);
  }

  .claim-head {
    display: flex;
    justify-content: space-between;
    gap: var(--wa-space-s);
    flex-wrap: wrap;
  }

  .claim-target {
    margin: 0;
  }

  .claim-message {
    margin: 0;
    padding: var(--wa-space-xs) var(--wa-space-s);
    border-left: 3px solid var(--wa-color-surface-border);
    white-space: pre-wrap;
  }

  .muted {
    color: var(--wa-color-text-quiet);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
  }

  .field input {
    padding: var(--wa-space-2xs);
    font: inherit;
  }

  .field-label {
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-text-quiet);
  }
</style>
