<script lang="ts">
  // Vote tally for an edition's work link: the per-work counts and the viewer's
  // own vote. The link and consensus sentence live in the dock bar above it.
  import type { EditionWorkStatus } from "$lib/server/edition-work-votes";
  import { workRkey } from "$lib/edition-votes";

  let { status }: { status: EditionWorkStatus } = $props();
</script>

{#if status.tally.links.length > 0 || status.tally.unlinkCount > 0}
  <ul class="tally">
    {#each status.tally.links as link (link.workUri)}
      <li>
        <code>{workRkey(link.workUri)}</code>
        <span class="count">{link.count} link</span>
      </li>
    {/each}
    {#if status.tally.unlinkCount > 0}
      <li>
        <span class="muted">unlink</span>
        <span class="count">{status.tally.unlinkCount}</span>
      </li>
    {/if}
  </ul>
{/if}

{#if status.myVote}
  <p class="muted small">
    Your vote:
    {#if status.myVote.action === "link"}
      link to <code>{workRkey(status.myVote.workUri ?? "")}</code>
    {:else}
      unlink
    {/if}
  </p>
{/if}

<style>
  .tally {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--wa-space-s);
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-m);
  }
  .tally li {
    display: flex;
    gap: var(--wa-space-s);
    align-items: baseline;
    font-size: var(--wa-font-size-s);
  }
  p {
    margin: 0 0 var(--wa-space-s);
  }
  .count {
    color: var(--wa-color-on-quiet);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
  .small {
    font-size: var(--wa-font-size-s);
  }
</style>
