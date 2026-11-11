import type { PageServerLoad } from './$types';
import { lexiconForNsid, publishedNsids } from '$lib/server/lexicon-map';

export const load: PageServerLoad = async () => {
	const queries = publishedNsids().filter((nsid) => {
		const main = lexiconForNsid(nsid)?.defs as Record<string, { type?: string }> | undefined;
		return main?.main?.type === 'query';
	}).length;
	return { endpointCounts: { queries } };
};
