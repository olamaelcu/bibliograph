import type { LexiconEndpoint } from '../lexicon-catalog.js';

export type ExampleCategory = 'independent' | 'composite' | 'list';

export interface CategorizedExample {
	endpoint: LexiconEndpoint;
	category: ExampleCategory;
	/** ESM renderer name exported from `/static/renderers.js`. */
	renderer: string;
}

/**
 * Names of queries grouped by demo category. Anything not listed here
 * (e.g. `com.atproto.lexicon.resolveLexicon`) is intentionally excluded
 * from `/examples`.
 */
const INDEPENDENT = new Set<string>([
	'getActor',
	'getBook',
	'getBookOnShelf',
	'getContributor',
	'getGenre',
	'getShelf',
]);

const COMPOSITE = new Set<string>([
	'getShelvingOfBook',
	'listBooksOnShelf',
]);

const LIST = new Set<string>([
	'listBooks',
	'listGenres',
	'listShelves',
	'listShelvesWithBooks',
	'searchBooks',
	'searchContributors',
]);

/** Map from the lexicon's last-segment name to the renderer fn in `src/public/renderers.js`. */
const RENDERER: Readonly<Record<string, string>> = {
	getActor: 'renderActor',
	getBook: 'renderBook',
	getBookOnShelf: 'renderBookShelf',
	getContributor: 'renderContributor',
	getGenre: 'renderGenre',
	getShelf: 'renderShelf',
	getShelvingOfBook: 'renderListResults',
	listBooks: 'renderListResults',
	listBooksOnShelf: 'renderListResults',
	listGenres: 'renderListResults',
	listShelves: 'renderListResults',
	listShelvesWithBooks: 'renderListResults',
	searchBooks: 'renderSearchResults',
	searchContributors: 'renderSearchResults',
};

function categoryOf(name: string): ExampleCategory | undefined {
	if (INDEPENDENT.has(name)) return 'independent';
	if (COMPOSITE.has(name)) return 'composite';
	if (LIST.has(name)) return 'list';
	return undefined;
}

/** Return demo entries for every query endpoint, ordered by category then NSID. */
export function exampleEntries(endpoints: LexiconEndpoint[]): CategorizedExample[] {
	const out: CategorizedExample[] = [];
	for (const endpoint of endpoints) {
		if (endpoint.type !== 'query') continue;
		const category = categoryOf(endpoint.name);
		if (!category) continue;
		const renderer = RENDERER[endpoint.name];
		if (!renderer) continue;
		out.push({ endpoint, category, renderer });
	}
	out.sort((a, b) => (a.endpoint.id < b.endpoint.id ? -1 : a.endpoint.id > b.endpoint.id ? 1 : 0));
	return out;
}

/** Group entries by category in display order. */
export function groupByCategory(entries: CategorizedExample[]): Record<ExampleCategory, CategorizedExample[]> {
	const groups: Record<ExampleCategory, CategorizedExample[]> = {
		independent: [],
		composite: [],
		list: [],
	};
	for (const entry of entries) groups[entry.category].push(entry);
	return groups;
}

/** Find a single demo entry by last-segment name. */
export function findExample(endpoints: LexiconEndpoint[], name: string): CategorizedExample | undefined {
	const endpoint = endpoints.find((e) => e.type === 'query' && e.name === name);
	if (!endpoint) return undefined;
	const category = categoryOf(endpoint.name);
	if (!category) return undefined;
	const renderer = RENDERER[endpoint.name];
	if (!renderer) return undefined;
	return { endpoint, category, renderer };
}
