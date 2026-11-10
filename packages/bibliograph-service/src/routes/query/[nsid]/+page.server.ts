import { error } from '@sveltejs/kit';
import { queryRegistry } from '$lib/server/xrpc-router';
import { cleanSchema, getErrors, summarizeSchema } from '$lib/server/schema-render';
import type { PageServerLoad } from './$types';

/**
 * The registry never mutates, so the cleaned schema text of an nsid is a constant.
 * `cleanSchema` deep-clones the whole generated valibot graph, which ran on every
 * render of this page.
 */
const schemaText = new Map<string, string>();

function schemaTextFor(nsid: string, schema: unknown): string {
  const cached = schemaText.get(nsid);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(cleanSchema(schema), null, 2);
  schemaText.set(nsid, text);
  return text;
}

export const load: PageServerLoad = async ({ params }) => {
  const nsid = decodeURIComponent(params.nsid);
  if (nsid.startsWith('com.atproto.')) error(404, `Unknown query: ${nsid}`);
  const schema = queryRegistry.get(nsid);
  if (!schema) error(404, `Unknown query: ${nsid}`);

  const s = schema as { params?: unknown; output?: { schema?: unknown } };
  return {
    nsid,
    schemaRaw: schemaTextFor(nsid, schema),
    params: s.params ? summarizeSchema(s.params) : undefined,
    output: s.output?.schema ? summarizeSchema(s.output.schema) : undefined,
    errors: getErrors(schema),
  };
};
