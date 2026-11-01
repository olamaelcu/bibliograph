<script lang="ts">
  // Page frame shared by the record detail routes: padding, the way back, and
  // the not-found state. The route decides what to render inside it.
  import type { Snippet } from "svelte";

  let {
    label,
    rkey,
    notFound,
    children,
  }: {
    /** Singular record kind, e.g. "Edition". */
    label: string;
    rkey: string;
    notFound: boolean;
    children?: Snippet;
  } = $props();
</script>

<main>
  <p class="back"><a href="/search">← Back to search</a></p>

  {#if notFound}
    <section class="missing">
      <h1>{label} not found</h1>
      <p class="muted">
        No {label.toLowerCase()} record exists for rkey <code>{rkey}</code>.
      </p>
    </section>
  {:else}
    {@render children?.()}
  {/if}
</main>

<style>
  main {
    padding: var(--wa-space-l);
    max-width: 68rem;
    margin: 0 auto;
  }
  .back {
    margin: 0 0 var(--wa-space-m);
    color: var(--wa-color-on-quiet);
  }
  .back a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }
  .back a:hover {
    text-decoration: underline;
  }
  .missing {
    padding: var(--wa-space-l) 0;
  }
  .missing h1 {
    margin: 0 0 var(--wa-space-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
</style>
