<script lang="ts">
  // Post-action feedback for form actions: the failure message, or a success
  // line supplied by the caller (a vote and a label toggle do not say the same
  // thing).
  let {
    form,
    success,
  }: {
    form: { error?: string; ok?: boolean } | undefined;
    success: string;
  } = $props();
</script>

{#if form?.error}
  <wa-callout variant="danger" appearance="outlined" class="feedback">
    {form.error}
  </wa-callout>
{:else if form?.ok}
  <wa-callout variant="success" appearance="outlined" class="feedback">
    {success}
  </wa-callout>
{/if}

<style>
  .feedback {
    margin-block-end: var(--wa-space-m);
  }
</style>
