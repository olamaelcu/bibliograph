import { queryRegistry } from '$lib/server/xrpc-router';
import { summarizeSchema } from '$lib/server/schema-render';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const endpoints = Array.from(queryRegistry.entries())
    .map(([nsid, schema]) => {
      const s = schema as { params?: unknown; description?: string };
      return {
        nsid,
        description: s.description,
        params: s.params ? summarizeSchema(s.params) : undefined,
      };
    })
    .filter(({ nsid }) => !nsid.startsWith('com.atproto.'))
    .sort((a, b) => a.nsid.localeCompare(b.nsid));
  return { endpoints };
};
