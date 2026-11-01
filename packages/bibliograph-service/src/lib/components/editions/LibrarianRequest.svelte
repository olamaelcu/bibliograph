<script lang="ts">
  // Librarian-access states, verbatim from the pre-redesign page: the same three
  // branches, the same copy, the same action. Kept in one component because every
  // redesign option has to render it somewhere.
  import type { EditionApplication, EditionFormState } from "$lib/edition-votes";

  let {
    application,
    form,
  }: {
    application: EditionApplication;
    form: EditionFormState | undefined;
  } = $props();
</script>

<div class="request">
  {#if application?.status === "pending" || form?.requested}
    <p class="muted small">
      Your librarian access request is queued for review. Voting unlocks once a
      librarian issues the <code>librarian</code> label to your account.
    </p>
  {:else if application?.status === "rejected"}
    <p class="muted small">
      Your librarian request was declined. You can ask again with more context.
    </p>
    <form method="POST" action="?/requestLibrarian" class="request-form">
      <input
        type="text"
        name="note"
        maxlength="1000"
        placeholder="Why do you want to curate? (optional)"
      />
      <wa-button type="submit" appearance="outlined" size="s">Ask again</wa-button>
    </form>
  {:else}
    <p class="muted small">
      Curation is limited to accounts holding the <code>librarian</code> label.
      Request access and a librarian will review it.
    </p>
    <form method="POST" action="?/requestLibrarian" class="request-form">
      <input
        type="text"
        name="note"
        maxlength="1000"
        placeholder="Why do you want to curate? (optional)"
      />
      <wa-button type="submit" appearance="outlined" size="s"
        >Request librarian access</wa-button
      >
    </form>
  {/if}
</div>

<style>
  .small {
    font-size: var(--wa-font-size-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
  .request-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: center;
  }
  .request-form input {
    min-width: 18rem;
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-s);
  }
</style>
