<script lang="ts">
  // Contributor detail route: hero with lifespan chips, then the metadata card
  // with the bio, aliases and identifiers.
  import DetailFrame from "$lib/components/records/DetailFrame.svelte";
  import RecordBody from "$lib/components/records/RecordBody.svelte";
  import RecordHero from "$lib/components/records/RecordHero.svelte";
  import RecordCard from "$lib/components/RecordCard.svelte";
  import type { DetailValue } from "$lib/types/record-detail";
  import type { BodyColumn, Chip } from "$lib/record-page";
  import { identifierItems, isContributorValue } from "$lib/record-page";

  let {
    data,
  }: {
    data: {
      kind: "contributors";
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
    };
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
</style>
