import { error } from '@sveltejs/kit';
import { queryRegistry } from '$lib/server/xrpc-router';
import { cleanSchema, getErrors, summarizeSchema } from '$lib/server/schema-render';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const nsid = decodeURIComponent(params.nsid);
  const schema = queryRegistry.get(nsid);
  if (!schema) error(404, `Unknown query: ${nsid}`);

  const s = schema as { params?: unknown; output?: { schema?: unknown } };
  return {
    nsid,
    schemaRaw: JSON.stringify(cleanSchema(schema), null, 2),
    params: s.params ? summarizeSchema(s.params) : undefined,
    output: s.output?.schema ? summarizeSchema(s.output.schema) : undefined,
    errors: getErrors(schema),
  };
};
