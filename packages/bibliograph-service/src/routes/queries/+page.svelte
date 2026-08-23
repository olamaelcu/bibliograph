<script lang="ts">
  let { data }: {
    data: {
      endpoints: Array<{
        nsid: string;
        description?: string;
        params?: { kind: string; description?: string; fields?: Array<{ name: string; type: string; required: boolean }> };
      }>;
    };
  } = $props();
</script>

<main>
  <section class="page-intro">
    <h1>Queries</h1>
    <p class="muted">
      Every query exposed by this AppView over <code>/xrpc</code>. Documented directly from the
      registered schemas — adding a <code>router.addQuery(...)</code> call to <code>xrpc-router.ts</code>
      makes the endpoint appear here on next page load.
    </p>
  </section>

  <section class="grid">
    {#each data.endpoints as { nsid, description, params }}
      <wa-card class="endpoint-card">
        <div slot="header" class="card-header">
          <code class="endpoint-id"><a href={`/query/${encodeURIComponent(nsid)}`}>{nsid}</a></code>
          <wa-badge variant="brand" appearance="tint">query</wa-badge>
        </div>
        {#if description}
          <p>{description}</p>
        {/if}
        {#if params?.fields && params.fields.length > 0}
          <p class="muted">
            Parameters: {params.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${f.type}`).join(', ')}
          </p>
        {/if}
        <p class="muted">
          Try at <code><a href={`/xrpc/${nsid}`}>/xrpc/{nsid}</a></code>
        </p>
        <div slot="footer" class="card-footer">
          <wa-button variant="default" appearance="outlined" size="small" href={`/query/${encodeURIComponent(nsid)}`}>
            View schema →
          </wa-button>
        </div>
      </wa-card>
    {/each}
  </section>
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

  .card-footer {
    text-align: right;
  }
</style>
