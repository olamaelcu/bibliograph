<script lang="ts">
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();
</script>

<main class="admin-main admin-login">
  <wa-card appearance="outlined" class="admin-login-card">
    <div class="wa-stack wa-gap-m">
      <div class="wa-stack wa-gap-2xs">
        <h1>Admin sign-in</h1>
        <p class="muted">
          Enter the operator token configured as <code>ADMIN_TOKEN</code> on this deployment.
        </p>
      </div>

      {#if form?.error}
        <wa-callout variant="danger">{form.error}</wa-callout>
      {/if}

      <form method="POST" class="wa-stack wa-gap-m">
        <label class="field">
          <span class="field-label">Operator token</span>
          <input
            class="admin-token-input"
            type="password"
            name="token"
            autocomplete="current-password"
            required
          />
        </label>
        <div>
          <wa-button type="submit" variant="brand">Sign in</wa-button>
        </div>
      </form>

      <p class="muted admin-small">
        The cookie is HttpOnly and SameSite=Strict. The token itself never reaches page source or
        browser storage.
      </p>
    </div>
  </wa-card>
</main>
