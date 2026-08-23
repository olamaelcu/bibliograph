import { procedureRegistry } from '$lib/server/xrpc-router';
import { summarizeSchema } from '$lib/server/schema-render';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const endpoints = Array.from(procedureRegistry.entries())
    .map(([nsid, schema]) => {
      const s = schema as { description?: string };
      return { nsid, description: s.description };
    })
    .sort((a, b) => a.nsid.localeCompare(b.nsid));
  return { endpoints };
};
