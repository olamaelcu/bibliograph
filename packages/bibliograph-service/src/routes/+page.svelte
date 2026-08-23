<script lang="ts">
  let {
    data,
  }: {
    data: {
      endpointCounts: { queries: number; procedures: number; records: number };
    };
  } = $props();
</script>

<main>
  <section class="hero">
    <wa-badge variant="brand" appearance="tint">AT Protocol AppView</wa-badge>
    <h1>Bibliograph dives into books,<br />so you don't have to.</h1>
    <p class="hero-sub">
      A literary-centric <a href="https://atproto.com/guides/glossary#app-view"
        >AppView</a
      >
      providing XRPC methods for the NSID
      <code>net.olamaelcu.livtet.biblio</code>.
    </p>
    <div class="hero-cta">
      <wa-button variant="brand" href="/queries" appearance="accent" size="m">
        Browse queries
      </wa-button>
    </div>
    <div class="code-block">
      <code>net.olamaelcu.livtet.biblio</code>
      <wa-copy-button value="net.olamaelcu.livtet.biblio" copy-label="Copy NSID"
      ></wa-copy-button>
    </div>
    <div class="hero-meta">
      <a href="/queries">
        <wa-badge variant="brand" appearance="filled"
          >{data.endpointCounts.queries} queries</wa-badge
        >
      </a>
      <a href="/procedures">
        <wa-badge variant="success" appearance="filled"
          >{data.endpointCounts.procedures} procedures</wa-badge
        >
      </a>
      <span class="muted">· read-only · records live in your PDS</span>
    </div>
  </section>

  <section class="about">
    <p>
      Every query and procedure is documented from the lexicon files and served
      over
      <code>/xrpc</code>. Callers authenticate with a DPoP-bound OAuth access
      token.
    </p>
  </section>
</main>

<style>
  /* ---- Hero (home page) --------------------------------------------- */

  .hero {
    max-width: 50rem;
    margin: 0 auto;
    padding: 3.5rem var(--wa-space-l) var(--wa-space-l);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  h1 {
    line-height: 1.12;
    letter-spacing: -0.02em;
    margin: 0;
  }

  .hero-sub {
    margin: 0;
    color: var(--wa-color-on-quiet);
    max-width: 42rem;
    font-size: var(--wa-font-size-m);
    line-height: 1.55;
  }

  .hero-cta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: var(--wa-space-m);
  }

  .code-block {
    display: flex;
    align-items: center;
    gap: var(--wa-space-m);
    background: var(--wa-color-surface-lowered);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: 8px;
    padding: var(--wa-space-m);
    margin-top: var(--wa-space-m);
    max-width: 100%;
  }

  .code-block code {
    overflow-x: auto;
    white-space: nowrap;
  }

  .hero-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-m);
    margin-top: var(--wa-space-s);
  }

  .muted {
    color: var(--wa-color-on-quiet);
  }

  .about {
    max-width: 50rem;
    margin: 0 auto;
    padding: var(--wa-space-m) var(--wa-space-l) var(--wa-space-l);
    color: var(--wa-color-on-quiet);
    line-height: 1.6;
  }
</style>
