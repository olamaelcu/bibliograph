import { lexiconForNsid, publishedNsids } from '$lib/server/lexicon-map';
import type { PageServerLoad } from './$types';

interface LexiconProperty {
	type?: string;
	description?: string;
	required?: string[];
}

interface LexiconMain {
	type?: string;
	description?: string;
	parameters?: { properties?: Record<string, LexiconProperty>; required?: string[] };
}

export interface EndpointField {
	name: string;
	type: string;
	required: boolean;
	description?: string;
}

export interface EndpointView {
	nsid: string;
	kind: 'query' | 'procedure';
	description?: string;
	fields: EndpointField[];
}

function fieldsOf(main: LexiconMain): EndpointField[] {
	const properties = main.parameters?.properties ?? {};
	const required = new Set(main.parameters?.required ?? []);
	return Object.entries(properties).map(([name, property]) => ({
		name,
		type: property.type ?? 'unknown',
		required: required.has(name),
		description: property.description,
	}));
}

export const load: PageServerLoad = async (): Promise<{ endpoints: EndpointView[] }> => {
	const endpoints: EndpointView[] = [];
	for (const nsid of publishedNsids()) {
		if (nsid.startsWith('com.atproto.')) continue;
		const lexicon = lexiconForNsid(nsid);
		const main = (lexicon?.defs as Record<string, LexiconMain> | undefined)?.main;
		const kind = main?.type === 'procedure' ? 'procedure' : main?.type === 'query' ? 'query' : null;
		if (!kind || !main) continue;
		endpoints.push({
			nsid,
			kind,
			description: main.description ?? (lexicon?.description as string | undefined),
			fields: fieldsOf(main),
		});
	}
	endpoints.sort((a, b) => a.nsid.localeCompare(b.nsid));
	return { endpoints };
};
