<script lang="ts">
  // Shown when the work-link section exists but nobody is signed in. The vote
  // itself lives in the visitor's repository, so there is nothing to show yet.
  let { rkey }: { rkey: string } = $props();
</script>

<p class="muted small">
  <a href={`/login?next=${encodeURIComponent(`/editions/${rkey}`)}`}
    >Sign in with your AT Protocol account</a
  >
  to see the work link and vote on it.
</p>

<style>
  .small {
    font-size: var(--wa-font-size-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
  a {
    color: var(--wa-color-text-link);
  }
</style>
