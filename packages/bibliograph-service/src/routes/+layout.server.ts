import type { LayoutServerLoad } from './$types';
import { hasAdminAccess } from '$lib/server/admin';
import { lexiconForNsid, publishedNsids } from '$lib/server/lexicon-map';

function endpointCounts(): { queries: number; records: number } {
	let queries = 0;
	let records = 0;
	for (const nsid of publishedNsids()) {
		const main = lexiconForNsid(nsid)?.defs as Record<string, { type?: string }> | undefined;
		const type = main?.main?.type;
		if (type === 'query') queries += 1;
		if (type === 'record') records += 1;
	}
	return { queries, records };
}

export const load: LayoutServerLoad = async ({ request, cookies }) => ({
	isAdmin: hasAdminAccess({ request, cookies }),
	endpointCounts: endpointCounts(),
});
