<script lang="ts">
  import RecordCard from '$lib/components/RecordCard.svelte';
  import type { DetailValue } from '$lib/types/record-detail';
  let { data }: { data: { kind: 'publishers'; rkey: string; notFound: boolean; value?: DetailValue } } = $props();
</script>

<main>
  <p><a href="/search">← Back to search</a></p>
  {#if data.notFound}
    <section class="missing">
      <h1>Publisher not found</h1>
      <p class="muted">No publisher record exists for rkey <code>{data.rkey}</code>.</p>
    </section>
  {:else if data.value}
    <RecordCard value={data.value} />
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
</style>
