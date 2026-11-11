<script lang="ts">
  // Contributor detail route: hero with lifespan chips, then the metadata card
  // with the bio, aliases and identifiers.
  import ActionFeedback from "$lib/components/records/ActionFeedback.svelte";
  import DetailFrame from "$lib/components/records/DetailFrame.svelte";
  import RecordBody from "$lib/components/records/RecordBody.svelte";
  import RecordHero from "$lib/components/records/RecordHero.svelte";
  import RecordCard from "$lib/components/RecordCard.svelte";
  import type { DetailValue } from "$lib/types/record-detail";
  import type { BodyColumn, Chip } from "$lib/record-page";
  import { identifierItems, isContributorValue } from "$lib/record-page";

  let {
    data,
    form,
  }: {
    data: {
      kind: "contributors";
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
      canLabel: boolean;
    };
    form?: { error?: string; ok?: boolean; backfill?: boolean };
  } = $props();

  const chips = $derived.by((): Chip[] => {
    const value = data.value;
    if (!isContributorValue(value)) return [];
    const list: Chip[] = [];
    if (value.bornYear) list.push({ label: `b. ${value.bornYear}` });
    if (value.diedYear) list.push({ label: `d. ${value.diedYear}` });
    return list;
  });

  const columns = $derived.by((): BodyColumn[] => {
    const value = data.value;
    if (!isContributorValue(value)) return [];
    const list: BodyColumn[] = [];
    if (value.linkedDid) {
      list.push({
        title: "Linked account",
        items: [{ text: value.linkedDid, code: true }],
      });
    }
    list.push({ title: "Identifiers", items: identifierItems(value.identifiers) });
    return list;
  });
</script>

<DetailFrame label="Contributor" rkey={data.rkey} notFound={data.notFound}>
  {#if isContributorValue(data.value)}
    <section class="detail">
      <RecordHero
        kicker="Contributor"
        kickerDetail={data.rkey}
        title={data.value.name}
        subtitle={data.value.aliases.length > 0
          ? `also known as ${data.value.aliases.join(", ")}`
          : undefined}
        {chips}
      />

      <ActionFeedback {form} success="Backfill queued for this contributor." />
      {#if data.canLabel}
        <form method="POST" action="?/runBackfill" class="backfill-form">
          <wa-button type="submit" appearance="outlined" size="s">
            Queue portrait + bio backfill
          </wa-button>
          <span class="muted small">
            Wikidata/Commons portrait and Wikipedia bio. Fills missing fields
            only; runs on the worker.
          </span>
        </form>
      {/if}

      <RecordBody
        description={data.value.bio}
        tags={data.value.aliases}
        {columns}
      />
    </section>
  {:else if data.value}
    <RecordCard value={data.value} />
  {/if}
</DetailFrame>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-l);
  }
  .backfill-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
    align-items: center;
  }
  .small {
    font-size: var(--wa-font-size-s);
  }
  .muted {
    color: var(--wa-color-on-quiet);
  }
</style>
