import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import {
	bookIdentifiers,
	contributorIdentifiers,
	contributors,
	editions,
} from '../db/schema.js';
import { getEngagementForSubject } from '../network/constellation.js';
import type { PdsRecord, ViewContext } from '../lex/collections.js';
import { COLLECTION } from '../lex/collections.js';
import type {
	ActorView,
	BookShelfView,
	ContributorView,
	EditionView,
	Identifier,
	ShelfView,
	ShelfWithBooksView,
} from './views.js';

type Db = NodePgDatabase<typeof schema>;

function asDid(value: string): `did:${string}:${string}` {
	return value as `did:${string}:${string}`;
}

/** Build the canonical at-uri for a service-owned record. */
function recordUri(ctx: ViewContext, collection: string, rkey: string): string {
	return `at://${ctx.serviceDid}/${collection}/${rkey}`;
}

/** Attach bsky iff constellation returns non-zero counts. */
async function attachBsky<T extends object>(
uri: string,
view: T,
): Promise<T> {
	const bsky = await getEngagementForSubject(uri);
	if (bsky && (bsky.likeCount > 0 || bsky.quoteCount > 0)) {
		(view as { bsky?: { likeCount: number; quoteCount: number } }).bsky = {
			likeCount: bsky.likeCount,
			quoteCount: bsky.quoteCount,
		};
	}
	return view;
}

// ─── contributor ────────────────────────────────────────────────────────────

export async function toContributorView(
db: Db,
ctx: ViewContext,
row: typeof contributors.$inferSelect,
): Promise<ContributorView> {
	const uri = recordUri(ctx, COLLECTION.contributor, row.pk);
	const idents = await db.select().from(contributorIdentifiers).where(eq(contributorIdentifiers.contributorPk, row.pk));
	const v: ContributorView = {
		uri,
		name: row.name,
		identifiers: idents.map((i) => ({ uri: i.uri, resource: i.valueScheme })),
	};
	if (row.sortName) v.sortName = row.sortName;
	if (row.bio) v.bio = row.bio;
	if (row.createdAt) v.createdAt = new Date(row.createdAt * 1000).toISOString();
	if (row.updatedAt != null) v.updatedAt = new Date(row.updatedAt * 1000).toISOString();
	return attachBsky(uri, v);
}

// ─── edition ────────────────────────────────────────────────────────────────

export async function toEditionView(
db: Db,
ctx: ViewContext,
row: typeof editions.$inferSelect,
): Promise<EditionView> {
	const identifiersRows = await db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, row.pk));
	const subjects = (row.contributors ?? []) as { subject: string; role: string }[];
	const contributorRkeys = subjects
		.map((s) => s.subject.split('/').pop())
		.filter((s): s is string => !!s);
	const contributorRows = contributorRkeys.length
		? await db.select().from(contributors).where(inArray(contributors.pk, contributorRkeys))
		: [];
	// Fallback: fetch any missing contributors individually.
	const contributorsByPk = new Map<string, typeof contributors.$inferSelect>();
	for (const c of contributorRows) contributorsByPk.set(c.pk, c);
	if (contributorsByPk.size !== contributorRkeys.length) {
		for (const k of contributorRkeys) {
			if (!contributorsByPk.has(k)) {
				const c = (await db.select().from(contributors).where(eq(contributors.pk, k)))[0];
				if (c) contributorsByPk.set(c.pk, c);
			}
		}
	}
	const contributorViews: ContributorView[] = subjects
		.map((s) => {
			const rkey = s.subject.split('/').pop()!;
			const c = contributorsByPk.get(rkey);
			if (!c) return null;
			return { uri: s.subject, name: c.name, role: s.role } as ContributorView;
		})
		.filter((v): v is ContributorView => v !== null);
	const view: EditionView = {
		uri: recordUri(ctx, COLLECTION.edition, row.pk),
		title: row.title,
		identifiers: identifiersRows.map((i) => ({ uri: i.uri, resource: i.valueScheme })),
		contributors: contributorViews,
	};
	if (row.subtitle) view.subtitle = row.subtitle;
	if (row.publishedYear != null) view.publishedYear = row.publishedYear;
	if (row.language) view.language = row.language;
	if (row.place) view.place = row.place;
	if (row.description) view.description = row.description;
	if (row.createdAt) view.createdAt = new Date(row.createdAt * 1000).toISOString();
	if (row.updatedAt != null) view.updatedAt = new Date(row.updatedAt * 1000).toISOString();
	return view;
}

/**
 * Lightweight edition view for embedded `bookShelving.book` refs. Strips
 * identifiers/contributors to bare minimums so shelvings survive edition
 * deletion and add no significant storage overhead per record.
 */
export async function toExpandedEdition(
db: Db,
ctx: ViewContext,
row: { pk: string; title: string },
): Promise<EditionView | undefined> {
	const rec = (await db.select().from(editions).where(eq(editions.pk, row.pk)))[0];
	if (!rec) return undefined;
	const identifiersRows = await db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, row.pk));
	const subjects = (rec.contributors ?? []) as { subject: string; role: string }[];
	const contributorRkeys = subjects
		.map((s) => s.subject.split('/').pop())
		.filter((s): s is string => !!s);
	const contributorRows = contributorRkeys.length
		? await db.select().from(contributors).where(eq(contributors.pk, contributorRkeys[0]!))
		: [];
	const contributorName = contributorRows[0]?.name;
	return {
		uri: recordUri(ctx, COLLECTION.edition, row.pk),
		title: row.title,
		identifiers: identifiersRows.map((i) => ({ uri: i.uri, resource: i.valueScheme })),
		contributors: contributorName
			? [{ uri: subjects[0]!.subject, name: contributorName, role: subjects[0]!.role } as ContributorView]
			: [],
	} as EditionView;
}

/** Look up an edition by its local-canonical at-uri rkey and hydrate an EditionView. */
export async function hydrateEdition(
db: Db,
ctx: ViewContext,
editionUri: string,
): Promise<EditionView | undefined> {
	const m = editionUri.match(/^at:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
	if (!m) return undefined;
	const rkey = m[2];
	const row = (await db.select().from(editions).where(eq(editions.pk, rkey)))[0];
	if (!row) return undefined;
	return toEditionView(db, ctx, row);
}

// ─── shelves / actors (from user_records) ───────────────────────────────────

export function toShelfView(rec: PdsRecord): ShelfView {
	const value = rec.value as { name: string; description?: string; createdAt?: string };
	const v: ShelfView = {
		uri: rec.uri,
		name: value.name,
	};
	if (value.description) v.description = value.description;
	if (value.createdAt) v.createdAt = value.createdAt;
	return v;
}

export async function withShelfBsky(view: ShelfView): Promise<ShelfView> {
	return attachBsky(view.uri, view);
}

export function toActorView(rec: PdsRecord | undefined, did: string): ActorView {
	const v: ActorView = { did: asDid(did) };
	if (rec?.value && typeof rec.value === 'object') {
		const value = rec.value as { displayName?: string; description?: string };
		if (value.displayName) v.displayName = value.displayName;
		if (value.description) v.description = value.description;
	}
	return v;
}

export async function withActorBsky(view: ActorView): Promise<ActorView> {
	return attachBsky(view.did, view);
}

export function toBookShelfView(
rec: PdsRecord,
did: string,
shelf: ShelfView,
book: EditionView,
): BookShelfView {
	const value = rec.value as {
		metadata?: { status?: string; position?: number; notes?: string; emoji?: string };
		createdAt?: string;
	};
	const metadata: BookShelfView['metadata'] = {
		status: (value.metadata?.status ?? 'to-read') as BookShelfView['metadata']['status'],
	};
	if (value.metadata?.position != null) metadata.position = value.metadata.position;
	if (value.metadata?.notes) metadata.notes = value.metadata.notes;
	if (value.metadata?.emoji) metadata.emoji = value.metadata.emoji;
	const v: BookShelfView = {
		uri: rec.uri,
		shelf,
		book,
		metadata,
		did: asDid(did),
	};
	if (value.createdAt) v.createdAt = value.createdAt;
	return v;
}

export function toShelfWithBooksView(shelf: ShelfView, books: BookShelfView[]): ShelfWithBooksView {
	return { shelf, books };
}

// Re-export Identifier for backwards compat with consumers.
export type { Identifier };