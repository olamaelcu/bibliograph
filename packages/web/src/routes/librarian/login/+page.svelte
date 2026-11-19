<script lang="ts">
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
  <title>Librarian sign-in</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="librarian-login">
  <h1>Librarian sign-in</h1>
  <p>
    Sign in with the ATProto account that a maintainer listed for this host. Your
    DID is recorded against every claim you decide.
  </p>

  {#if data.allowlist === 0}
    <p class="warn">
      This host has no librarians configured, so no account can sign in. Set
      <code>LIBRARIAN_DIDS</code> and restart.
    </p>
  {/if}

  {#if form?.message}
    <p class="error" role="alert">{form.message}</p>
  {/if}

  <form method="POST">
    <label for="handle">Handle</label>
    <input
      id="handle"
      name="handle"
      type="text"
      placeholder="alice.bsky.social"
      autocomplete="username"
      value={form?.handle ?? ''}
      required
    />
    <button type="submit">Sign in</button>
  </form>
</main>

<style>
  .librarian-login {
    max-width: 32rem;
    margin: var(--wa-space-2xl, 3rem) auto;
    padding: 0 var(--wa-space-l, 1rem);
    font-family: var(--wa-font-family-body, system-ui, sans-serif);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  input,
  button {
    padding: 0.6rem 0.75rem;
    font: inherit;
  }

  button {
    cursor: pointer;
  }

  .warn {
    color: var(--wa-color-warning-60, #8a5a00);
  }

  .error {
    color: var(--wa-color-danger-60, #a01b1b);
  }
</style>
