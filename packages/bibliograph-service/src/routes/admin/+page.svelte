<script lang="ts">
  let {
    data,
  }: {
    data: { pendingApplications: number };
  } = $props();
</script>

<main>
  <h1>Admin</h1>
  <p class="lede">
    Curation tools. Each page re-checks the <code>administrator</code> credential on the
    server, so a link here is not what grants access.
  </p>

  <div class="tools">
    <a class="tool" href="/admin/applications">
      <span class="title">Librarian queue</span>
      <span class="body">
        Approve, decline, or revoke librarian access, and manage the administrator and
        senior-librarian credentials.
      </span>
      <span class="meta">
        {data.pendingApplications === 0
          ? 'Nothing pending'
          : `${data.pendingApplications} pending`}
      </span>
    </a>

    <a class="tool" href="/admin/import/isbn">
      <span class="title">ISBN import</span>
      <span class="body">
        Look a print ISBN up across iSBNdb, Google Books, and Open Library, then edit and
        publish the edition record.
      </span>
      <span class="meta">Publishes to the labeler repo</span>
    </a>

    <a class="tool" href="/admin/editions/merge">
      <span class="title">Edition merge</span>
      <span class="body">
        Collapse duplicate catalog rows into one: the winner keeps its URI and absorbs every
        identifier and contributor.
      </span>
      <span class="meta">Deletes the losing rows</span>
    </a>
  </div>
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 56rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-l); }

  .tools {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--wa-space-m);
  }

  .tool {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-raised);
    color: var(--wa-color-text-normal);
    text-decoration: none;
  }

  .tool:hover {
    border-color: var(--wa-color-brand-50);
  }

  .title { font-weight: 700; }
  .body { color: var(--wa-color-on-quiet); font-size: var(--wa-font-size-s); }
  .meta {
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-xs);
    margin-block-start: auto;
  }
</style>
