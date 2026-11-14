<script lang="ts">
  import EntityEditor from '$lib/admin/EntityEditor.svelte';
  import type { AdminPublisherRecord } from '$lib/admin/types';

  let {
    data,
    form
  }: {
    data: { publisher: AdminPublisherRecord };
    form: { message?: string } | null;
  } = $props();
</script>

<EntityEditor kind="publisher" record={data.publisher} {form} />
