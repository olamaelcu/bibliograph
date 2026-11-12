<script lang="ts">
  import EntityEditor from '$lib/admin/EntityEditor.svelte';
  import type { AdminContributorRecord } from '$lib/admin/types';

  let { data }: { data: { contributor: AdminContributorRecord } } = $props();
</script>

<EntityEditor kind="contributor" record={data.contributor} />
