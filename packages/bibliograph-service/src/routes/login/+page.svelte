<script lang="ts">
  let { data, form }: { data: { next: string; error: string | null }; form?: { error?: string; handle?: string } } = $props();
  const error = $derived(form?.error ?? data.error);
</script>

<main>
  <h1>Sign in</h1>
  <p class="lede">
    Bibliograph uses your AT Protocol account. Signing in lets you vote on which
    work an edition belongs to; your vote is stored in your own repository, not
    ours.
  </p>

  {#if error}
    <wa-callout variant="danger" style="margin-block-end: var(--wa-space-l)">
      {error}
    </wa-callout>
  {/if}

  <form method="POST" class="login-form">
    <input type="hidden" name="next" value={data.next} />
    <label for="handle">Handle or DID</label>
    <input
      id="handle"
      name="handle"
      type="text"
      required
      autocomplete="username"
      placeholder="you.bsky.social"
      value={form?.handle ?? ''}
    />
    <button type="submit" class="primary">Continue to your server</button>
  </form>

  <p class="scope-note">
    Bibliograph asks only for permission to write
    <code>net.olamaelcu.livtet.biblio.editionWorkLink</code> in your repository.
    It cannot read your other records, post for you, or touch your profile.
  </p>
</main>

<style>
  main { padding: var(--wa-space-l); max-width: 34rem; margin: 0 auto; }
  h1 { margin: 0 0 var(--wa-space-s); }
  .lede { color: var(--wa-color-on-quiet); margin: 0 0 var(--wa-space-l); }
  .login-form { display: flex; flex-direction: column; gap: var(--wa-space-s); }
  label { font-weight: 600; font-size: var(--wa-font-size-s); }
  input {
    padding: var(--wa-space-s) var(--wa-space-m);
    border: 1px solid var(--wa-form-control-border-color);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-size: var(--wa-font-size-m);
  }
  button {
    margin-block-start: var(--wa-space-m);
    padding: var(--wa-space-s) var(--wa-space-l);
    border: none;
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-brand-50);
    color: #fff;
    font-weight: 600;
    font-size: var(--wa-font-size-m);
    cursor: pointer;
    align-self: flex-start;
  }
  button:hover { filter: brightness(1.08); }
  .scope-note {
    margin-block-start: var(--wa-space-l);
    color: var(--wa-color-on-quiet);
    font-size: var(--wa-font-size-s);
  }
  code { font-size: 0.9em; }
</style>
