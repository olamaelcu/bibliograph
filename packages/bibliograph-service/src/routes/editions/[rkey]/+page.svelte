<script lang="ts">
  // Edition detail route. The view itself lives in `EditionDetail`: the page only
  // narrows the loaded record and owns the not-found branch.
  import DetailFrame from "$lib/components/records/DetailFrame.svelte";
  import EditionDetail from "$lib/components/editions/EditionDetail.svelte";
  import RecordCard from "$lib/components/RecordCard.svelte";
  import type { DetailValue } from "$lib/types/record-detail";
  import type { EditionWorkStatus } from "$lib/server/edition-work-votes";
  import type { EditionView } from "$lib/edition-votes";
  import { isEditionValue } from "$lib/record-page";
  import { useIsLoggedIn } from "$lib/stores/auth";

  type Candidate = { uri: string; title: string; year?: number };

  let {
    data,
    form,
  }: {
    data: {
      kind: "editions";
      rkey: string;
      notFound: boolean;
      value?: DetailValue;
      workStatus: EditionWorkStatus | null;
      candidates: Candidate[];
      canCurate: boolean;
      application: {
        status: "pending" | "approved" | "rejected" | "revoked";
      } | null;
      controversial: boolean;
      canLabel: boolean;
    };
    form: EditionView["form"];
  } = $props();

  // Session state comes from the TanStack store, hydrated by the root layout.
  const isLoggedIn = useIsLoggedIn();

  const view = $derived.by((): EditionView | null => {
    if (!isEditionValue(data.value)) return null;
    return {
      rkey: data.rkey,
      value: data.value,
      status: data.workStatus,
      candidates: data.candidates,
      canCurate: data.canCurate,
      application: data.application,
      controversial: data.controversial,
      canLabel: data.canLabel,
      loggedIn: isLoggedIn.current,
      form,
    };
  });
</script>

<DetailFrame label="Edition" rkey={data.rkey} notFound={data.notFound}>
  {#if view}
    <EditionDetail {...view} />
  {:else if data.value}
    <RecordCard value={data.value} />
  {/if}
</DetailFrame>
