<script lang="ts">
  // Admin-only toggle for the `controversial` label. Shared by the edition and
  // work pages, which expose the same `?/toggleControversial` action.
  let {
    controversial,
    canLabel,
  }: { controversial: boolean; canLabel: boolean } = $props();
</script>

{#if canLabel}
  <form method="POST" action="?/toggleControversial" class="label-form">
    <wa-button type="submit" appearance="outlined" size="s">
      {controversial
        ? "Remove controversial label"
        : "Mark as controversial"}
    </wa-button>
  </form>
{/if}

<style>
  .label-form {
    margin-block-end: var(--wa-space-m);
  }
</style>
