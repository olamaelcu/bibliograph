<script lang="ts">
  import RecordCard from '$lib/components/RecordCard.svelte';
  import type { DetailValue } from '$lib/types/record-detail';
  let {
    data,
    form,
  }: {
    data: {
      kind: 'works';
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
      controversial: boolean;
      canLabel: boolean;
    };
    form?: { error?: string; ok?: boolean };
  } = $props();
</script>

<main>
  <p><a href="/search">← Back to search</a></p>
  {#if data.notFound}
    <section class="missing">
      <h1>Work not found</h1>
      <p class="muted">No work record exists for rkey <code>{data.rkey}</code>.</p>
    </section>
  {:else if data.value}
    {#if data.controversial}
      <aside class="controversial">
        <strong>Controversial</strong>
        <span>Frequently challenged, restricted, or banned.</span>
      </aside>
    {/if}
    {#if form?.error}
      <wa-callout variant="danger" style="margin-block-end: var(--wa-space-m)">{form.error}</wa-callout>
    {/if}
    {#if data.canLabel}
      <form method="POST" action="?/toggleControversial" class="label-form">
        <button type="submit" class="secondary">
          {data.controversial ? 'Remove controversial label' : 'Mark as controversial'}
        </button>
      </form>
    {/if}
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
  .controversial {
    display: flex;
    gap: var(--wa-space-s);
    align-items: baseline;
    padding: var(--wa-space-s) var(--wa-space-m);
    margin-block-end: var(--wa-space-m);
    border: 1px solid var(--wa-color-warning-50, #b8860b);
    border-radius: var(--wa-border-radius-m);
    font-size: var(--wa-font-size-s);
    background: var(--wa-color-surface-raised);
  }
  .label-form { margin-block-end: var(--wa-space-m); }
  .label-form button {
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: transparent;
    color: var(--wa-color-text-normal);
    font-weight: 600;
    font-size: var(--wa-font-size-s);
    cursor: pointer;
  }
</style>
