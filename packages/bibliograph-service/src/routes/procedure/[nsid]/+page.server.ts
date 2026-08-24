import { error } from '@sveltejs/kit';
import { procedureRegistry } from '$lib/server/xrpc-router';
import { cleanSchema, getErrors, summarizeSchema } from '$lib/server/schema-render';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const nsid = decodeURIComponent(params.nsid);
  if (nsid.startsWith('com.atproto.')) error(404, `Unknown procedure: ${nsid}`);
  const schema = procedureRegistry.get(nsid);
  if (!schema) error(404, `Unknown procedure: ${nsid}`);

  const s = schema as { params?: unknown; input?: { schema?: unknown }; output?: { schema?: unknown } };
  return {
    nsid,
    schemaRaw: JSON.stringify(cleanSchema(schema), null, 2),
    params: s.params ? summarizeSchema(s.params) : undefined,
    input: s.input?.schema ? summarizeSchema(s.input.schema) : undefined,
    output: s.output?.schema ? summarizeSchema(s.output.schema) : undefined,
    errors: getErrors(schema),
  };
};
