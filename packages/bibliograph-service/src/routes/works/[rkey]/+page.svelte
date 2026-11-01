<script lang="ts">
  // Work detail route. Same skeleton as the edition page minus the vote dock:
  // hero with contributors, metadata card with the work's subjects.
  import ActionFeedback from "$lib/components/records/ActionFeedback.svelte";
  import ControversialToggle from "$lib/components/records/ControversialToggle.svelte";
  import DetailFrame from "$lib/components/records/DetailFrame.svelte";
  import RecordBody from "$lib/components/records/RecordBody.svelte";
  import RecordHero from "$lib/components/records/RecordHero.svelte";
  import RecordCard from "$lib/components/RecordCard.svelte";
  import type { DetailValue } from "$lib/types/record-detail";
  import type { BodyColumn, Chip } from "$lib/record-page";
  import {
    contributorItems,
    identifierItems,
    isWorkValue,
    peopleFromContributions,
  } from "$lib/record-page";

  let {
    data,
    form,
  }: {
    data: {
      kind: "works";
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
      controversial: boolean;
      canLabel: boolean;
    };
    form?: { error?: string; ok?: boolean };
  } = $props();

  const chips = $derived.by((): Chip[] => {
    const value = data.value;
    if (!isWorkValue(value)) return [];
    const list: Chip[] = [];
    if (value.firstPublishedYear) {
      list.push({ label: `first published ${value.firstPublishedYear}` });
    }
    if (value.originalLanguage) {
      list.push({ label: value.originalLanguage });
    }
    if (data.controversial) list.push({ label: "Controversial", tone: "danger" });
    return list;
  });

  const columns = $derived.by((): BodyColumn[] => {
    const value = data.value;
    if (!isWorkValue(value)) return [];
    return [
      { title: "Contributors", items: contributorItems(value.contributors) },
      { title: "Identifiers", items: identifierItems(value.identifiers) },
    ];
  });
</script>

<DetailFrame label="Work" rkey={data.rkey} notFound={data.notFound}>
  {#if isWorkValue(data.value)}
    <section class="detail">
      <RecordHero
        kicker="Work"
        kickerDetail={data.rkey}
        title={data.value.title}
        subtitle={data.value.subtitle}
        {chips}
        people={peopleFromContributions(data.value.contributors)}
      />

      <ActionFeedback {form} success="Controversial label updated." />
      <ControversialToggle
        controversial={data.controversial}
        canLabel={data.canLabel}
      />

      <RecordBody
        description={data.value.description}
        tags={data.value.subjects}
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
