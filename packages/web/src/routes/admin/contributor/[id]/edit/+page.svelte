<script lang="ts">
  import EntityEditor from '$lib/admin/EntityEditor.svelte';
  import type { AdminContributorRecord } from '$lib/admin/types';

  let {
    data,
    form
  }: {
    data: { contributor: AdminContributorRecord };
    form: { message?: string } | null;
  } = $props();
</script>

<EntityEditor kind="contributor" record={data.contributor} {form} />
