<script lang="ts">
  let { data }: { data: { endpoints: Array<{ nsid: string; description?: string }> } } = $props();
</script>

<main>
  <section class="page-intro">
    <h1>Procedures</h1>
    {#if data.endpoints.length === 0}
      <p class="muted">
        This AppView is read-only and does not implement any procedures.
        Procedures are listed here automatically when one is registered via
        <code>router.addProcedure(...)</code> in <code>xrpc-router.ts</code>.
      </p>
    {:else}
      <p class="muted">
        Procedures exposed by this AppView over <code>/xrpc</code>.
      </p>
    {/if}
  </section>

  {#if data.endpoints.length > 0}
    <section class="grid">
    {#each data.endpoints as { nsid, description }}
      <wa-card class="endpoint-card">
        <div slot="header" class="card-header">
          <code class="endpoint-id"><a href={`/procedure/${encodeURIComponent(nsid)}`}>{nsid}</a></code>
          <wa-badge variant="success" appearance="tint">procedure</wa-badge>
        </div>
        {#if description}
          <p>{description}</p>
        {/if}
        <p class="muted">
          Try at <code><a href={`/xrpc/${nsid}`}>/xrpc/{nsid}</a></code>
        </p>
      </wa-card>
    {/each}
    </section>
  {/if}
</main>

<style>
  .page-intro {
    max-width: 50rem;
    margin: 2rem auto 0;
    padding: 0 2rem;
  }
  .page-intro h1 {
    margin: 0 0 0.5rem;
  }
  .muted {
    color: var(--wa-color-on-quiet);
    line-height: 1.55;
    font-size: var(--wa-font-size-s);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(25rem, 1fr));
    gap: 1rem;
    padding: 1rem 2rem 2rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .endpoint-card {
    margin: 0;
  }
  .endpoint-id {
    font-weight: 600;
    flex: 1 1;
    word-break: break-all;
    font-size: var(--wa-font-size-s);
  }
  .endpoint-id a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }
</style>
