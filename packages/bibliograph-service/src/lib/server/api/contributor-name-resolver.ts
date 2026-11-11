import type { Logger } from 'pino';
import type { ContributorInput } from '../catalog/types';

// Editions inline their contributors on the wire, so provider authors need only
// a name. This resolver used to mint `community.lexicon.book.contributor`
// records and strongRefs; that namespace no longer exists.

export type ContributorSource = 'googlebooks' | 'isbndb' | 'goodreads' | 'openlibrary';

export interface ContributorResolver {
	resolve(names: readonly (string | null | undefined)[]): Promise<ContributorInput[]>;
}

const EMPTY: ContributorResolver = { async resolve() { return []; } };

export async function prefetchContributors(
	names: readonly (string | null | undefined)[],
	_source: ContributorSource,
	_log: Logger,
): Promise<ContributorResolver> {
	// Keep the call shape (one prefetch per page) even though nothing is looked
	// up: callers still pass the full author list and expect one resolver.
	if (names.length === 0) return EMPTY;
	const unique = Array.from(new Set(names.map((name) => name?.trim()).filter((name): name is string => !!name)));
	return {
		async resolve(list) {
			const out: ContributorInput[] = [];
			for (const raw of list) {
				const name = raw?.trim();
				if (!name || !unique.includes(name)) continue;
				out.push({ name, role: 'author' });
			}
			return out;
		},
	};
}
