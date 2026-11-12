<script lang="ts">
  import EntityEditor from '$lib/admin/EntityEditor.svelte';
  import type { AdminPublisherRecord } from '$lib/admin/types';

  let { data }: { data: { publisher: AdminPublisherRecord } } = $props();
</script>

<EntityEditor kind="publisher" record={data.publisher} />
