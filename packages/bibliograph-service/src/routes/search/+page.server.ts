import { searchEditionRows } from '$lib/server/catalog/store';
import { bookViewFromAppview } from '$lib/server/media-book-view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return { q, items: [], total: 0 };
	const result = await searchEditionRows({ titleText: q, limit: 25 });
	return { q, items: result.rows.map(bookViewFromAppview), total: result.total ?? result.rows.length };
};
