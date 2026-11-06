import { inArray } from 'drizzle-orm';
import { db } from './db';
import { contributors } from './db/schema';
import type { ContributorRef } from './book-wire';
import type { ContributionEntry } from './search/types';

/**
 * Resolve the contributor records a set of strongRefs points at.
 *
 * `defs#contributor` inlines `name` (required, `minLength: 1`) plus the
 * contributor's own identifiers, so every response that emits contributors —
 * search results and served records alike — needs this join. Looking it up in
 * one place keeps the served record value and the CID computed from it in sync.
 *
 * `executor` defaults to the app's client; jobs pass the executor they were
 * given so they stay testable against a fake database.
 */
export async function loadContributorRefs(
	uris: string[],
	executor: typeof db = db,
): Promise<Map<string, ContributorRef>> {
	if (uris.length === 0) return new Map();
	const rows = await executor
		.select({ uri: contributors.uri, name: contributors.name, identifiers: contributors.identifiers })
		.from(contributors)
		.where(inArray(contributors.uri, uris));
	return new Map(
		rows.map((row) => [row.uri, { name: row.name, identifiers: row.identifiers } satisfies ContributorRef]),
	);
}

/** The distinct contributor uris a batch of contribution entries points at. */
export function contributorUrisFor(entries: ReadonlyArray<ContributionEntry> | undefined): string[] {
	const uris = new Set<string>();
	for (const entry of entries ?? []) {
		if (entry.subject?.uri) uris.add(entry.subject.uri);
	}
	return [...uris];
}
