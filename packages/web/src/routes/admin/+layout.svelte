<script lang="ts">
  let { data, children } = $props();
</script>

<header class="topbar admin-topbar">
  <a class="brand" href="/admin">
    <wa-icon library="lucide" name="book-open"></wa-icon>
    <span class="brand-name">Bibliograph</span>
    <span class="brand-sub">admin</span>
  </a>
  <nav class="nav">
    <a href="/admin">Catalog curation</a>
    <a href="/">Public XRPC surface</a>
  </nav>
  {#if data.authenticated}
    <form method="POST" action="?/logout">
      <wa-button type="submit" appearance="plain" size="small">Sign out</wa-button>
    </form>
  {/if}
</header>

{@render children()}
