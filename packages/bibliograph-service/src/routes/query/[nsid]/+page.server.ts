import { error } from '@sveltejs/kit';
import { lexiconForNsid } from '$lib/server/lexicon-map';
import type { PageServerLoad } from './$types';

interface LexiconProperty {
	type?: string;
	description?: string;
	default?: unknown;
}

interface LexiconMain {
	type?: string;
	description?: string;
	parameters?: { properties?: Record<string, LexiconProperty>; required?: string[] };
	output?: { schema?: { properties?: Record<string, LexiconProperty>; required?: string[] } };
	errors?: Array<{ name: string; description?: string }>;
}

interface Field {
	name: string;
	type: string;
	required: boolean;
	description?: string;
	defaultValue?: string;
	constraints?: string[];
}

function fieldsFrom(
	properties: Record<string, LexiconProperty> | undefined,
	required: readonly string[] | undefined,
): Field[] {
	return Object.entries(properties ?? {}).map(([name, property]) => ({
		name,
		type: property.type ?? 'unknown',
		required: (required ?? []).includes(name),
		description: property.description,
		...(property.default === undefined ? {} : { defaultValue: JSON.stringify(property.default) }),
	}));
}

export const load: PageServerLoad = async ({ params }) => {
	const nsid = decodeURIComponent(params.nsid);
	if (nsid.startsWith('com.atproto.')) error(404, `Unknown query: ${nsid}`);
	const lexicon = lexiconForNsid(nsid);
	if (!lexicon) error(404, `Unknown query: ${nsid}`);
	const main = (lexicon.defs as Record<string, LexiconMain> | undefined)?.main;
	if (!main || (main.type !== 'query' && main.type !== 'procedure')) {
		error(404, `Unknown query: ${nsid}`);
	}
	const description = main.description ?? (lexicon.description as string | undefined);
	return {
		nsid,
		kind: main.type,
		schemaRaw: JSON.stringify(lexicon, null, 2),
		params: {
			kind: 'params' as const,
			description,
			fields: fieldsFrom(main.parameters?.properties, main.parameters?.required),
		},
		output: {
			kind: 'output' as const,
			fields: fieldsFrom(main.output?.schema?.properties, main.output?.schema?.required),
		},
		errors: main.errors ?? [],
	};
};
