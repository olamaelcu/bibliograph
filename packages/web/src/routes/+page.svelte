<script lang="ts">
  let { data } = $props();
</script>

<h1>bibliograph</h1>

{#if data.session}
  <p>
    Signed in as <strong>{data.session.handle}</strong>
    <small>({data.session.did}, scope: {data.session.scopes})</small>
  </p>
  <form method="POST" action="/logout">
    <button type="submit">Sign out</button>
  </form>
{:else}
  <p>Not signed in — XRPC calls through this edge are anonymous.</p>
  <form method="GET" action="/login">
    <label>
      Handle
      <input name="handle" placeholder="alice.pds.127-0-0-1.sslip.io" autocomplete="username" />
    </label>
    <button type="submit">Sign in with atproto</button>
  </form>
{/if}
