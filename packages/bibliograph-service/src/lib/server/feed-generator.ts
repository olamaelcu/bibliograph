// Feed generator over HappyView's activity index.
//
// No request path reads a user's PDS or Constellation: authors, reviews and
// shelving entries come from `happyview_records`, and the follow graph comes
// from the indexed `follow` records. A record missing from the index is simply
// absent until backfill/reconcile indexes it.

import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { PUBLISHER_DID } from './did';
import { verifyFeedAuth } from './auth/feed-auth';
import { blockedAmong } from './marco';
import { createLogger } from './logger';

const log = createLogger('web');

const FEED_GENERATOR = `${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator`;
const REVIEW_COLLECTION = 'community.lexicon.media.book.review';
const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';
const FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow';
const ACTIVITY_COLLECTIONS = [REVIEW_COLLECTION, SHELVING_COLLECTION];

/** PostgreSQL `IN (...)` list; drizzle expands an array into separate params. */
function inList(values: readonly string[]): SQL {
	return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

export interface FeedEntry {
	post: string;
	reason?: string;
}

interface ActivityRow {
	uri: string;
	did: string;
	collection: string;
	record: string | Record<string, unknown>;
}

function rowsOf<T>(result: unknown): T[] {
	return (result as { rows?: T[] }).rows ?? [];
}

function activityRecord(row: ActivityRow): Record<string, unknown> {
	if (typeof row.record !== 'string') return row.record;
	try {
		const parsed: unknown = JSON.parse(row.record);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function describeFeedGenerator(): { did: string; feeds: Array<{ uri: string }> } {
	return {
		did: PUBLISHER_DID,
		feeds: ['public', 'following', 'extended', 'dynamic'].map((name) => ({
			uri: `at://${FEED_GENERATOR}/${name}`,
		})),
	};
}

function feedName(feed: string): string {
	// `edition/<rkey>` has a slash in its name, so the suffix after the
	// generator is read whole rather than as one path segment.
	const marker = 'feed.generator/';
	const index = feed.indexOf(marker);
	if (index >= 0) return feed.slice(index + marker.length);
	// A bare feed name is accepted for convenience.
	return feed;
}

function reasonFor(row: ActivityRow): string | undefined {
	const record = activityRecord(row);
	if (row.collection === REVIEW_COLLECTION) {
		const subject = record.subjectRecord;
		return typeof subject === 'string' ? subject : undefined;
	}
	const shelf = typeof record.shelf === 'string' ? record.shelf : '';
	const shelfRkey = shelf.slice(shelf.lastIndexOf('/') + 1);
	const book = record.book;
	const bookUri =
		book && typeof book === 'object' && 'uri' in book && typeof book.uri === 'string' ? book.uri : '';
	return `shelving:${shelfRkey}|${bookUri}`;
}

async function followeeDids(did: string): Promise<string[]> {
	const rows = rowsOf<{ did: string }>(
		await db.execute(sql`
			SELECT split_part(regexp_replace((record::jsonb)->>'subject', '^at://', ''), '/', 1) AS did
			FROM happyview.happyview_records
			WHERE collection = ${FOLLOW_COLLECTION} AND did = ${did}
		`),
	);
	return rows.map((row) => row.did).filter((value) => value.startsWith('did:'));
}

async function extendedDids(did: string): Promise<string[]> {
	const hop1 = await followeeDids(did);
	if (hop1.length === 0) return [];
	const rows = rowsOf<{ did: string }>(
		await db.execute(sql`
			SELECT DISTINCT split_part(regexp_replace((record::jsonb)->>'subject', '^at://', ''), '/', 1) AS did
			FROM happyview.happyview_records
			WHERE collection = ${FOLLOW_COLLECTION} AND did IN (${inList(hop1)})
		`),
	);
	const excluded = new Set([did, ...hop1]);
	return rows.map((row) => row.did).filter((value) => value.startsWith('did:') && !excluded.has(value));
}

interface PageQuery {
	authors?: readonly string[];
	exclude?: readonly string[];
	limit: number;
	offset: number;
}

async function pageActivities(query: PageQuery): Promise<ActivityRow[]> {
	const conditions: SQL[] = [sql`collection IN (${inList(ACTIVITY_COLLECTIONS)})`];
	if (query.authors) conditions.push(sql`did IN (${inList(query.authors)})`);
	if (query.exclude && query.exclude.length > 0) conditions.push(sql`did NOT IN (${inList(query.exclude)})`);
	return rowsOf<ActivityRow>(
		await db.execute(sql`
			SELECT uri, did, collection, record FROM happyview.happyview_records
			WHERE ${sql.join(conditions, sql` AND `)}
			ORDER BY created_at DESC, uri DESC
			LIMIT ${query.limit} OFFSET ${query.offset}
		`),
	);
}

async function blockedAuthors(viewer: string, rows: readonly ActivityRow[]): Promise<Set<string>> {
	const dids = Array.from(new Set(rows.map((row) => row.did).filter((did) => did !== viewer)));
	return blockedAmong(viewer, dids, log);
}

async function editionReviews(editionUri: string, limit: number, offset: number): Promise<ActivityRow[]> {
	return rowsOf<ActivityRow>(
		await db.execute(sql`
			SELECT uri, did, collection, record FROM happyview.happyview_records
			WHERE collection = ${REVIEW_COLLECTION}
			  AND (
			    (record::jsonb)->>'subjectRecord' = ${editionUri}
			    OR EXISTS (
			      SELECT 1 FROM edition_identifiers i
			      WHERE i.edition_uri = ${editionUri}
			        AND (record::jsonb)->'subject'->'identifiers'
			            @> jsonb_build_array(jsonb_build_object('issuer', i.issuer, 'value', i.value))
			    )
			  )
			ORDER BY created_at DESC, uri DESC
			LIMIT ${limit} OFFSET ${offset}
		`),
	);
}

export interface FeedParams {
	feed: string;
	cursor?: string;
	limit: number;
}

export interface FeedResult {
	feed: FeedEntry[];
	cursor?: string;
}

export async function getFeedSkeleton(request: Request, params: FeedParams): Promise<FeedResult> {
	const name = feedName(params.feed);
	const limit = Math.min(Math.max(params.limit || 5, 5), 100);
	const offset = Math.max(Number.parseInt(params.cursor ?? '0', 10) || 0, 0);

	if (name === 'recommendations') return { feed: [] };

	if (name.startsWith('edition/') || name.startsWith('edition')) {
		const rkey = name.split('/')[1];
		if (!rkey) return { feed: [] };
		const editionUri = `at://${PUBLISHER_DID}/community.lexicon.media.book.edition/${rkey}`;
		const rows = await editionReviews(editionUri, limit, offset);
		if (rows.length === 0 && offset === 0) return { feed: [] };
		return {
			feed: rows.map((row) => ({ post: row.uri, reason: 'Backlink from edition review' })),
			cursor: rows.length === limit ? String(offset + rows.length) : undefined,
		};
	}

	const viewer = await verifyFeedAuth(request);
	const personalised = name === 'following' || name === 'extended' || name === 'dynamic';

	if (personalised && !viewer) {
		return { feed: [] };
	}

	let authors: readonly string[] | undefined;
	if (name === 'following' || name === 'dynamic') {
		authors = viewer ? await followeeDids(viewer) : [];
	} else if (name === 'extended') {
		authors = viewer ? await extendedDids(viewer) : [];
	}

	// A viewer who follows nobody gets the global feed on the first page; later
	// pages stay empty so the feed does not repeat itself.
	if (personalised && authors && authors.length === 0) {
		if (offset > 0) return { feed: [] };
		authors = undefined;
	}

	const rows = await pageActivities({
		authors,
		exclude: viewer ? [viewer] : undefined,
		limit,
		offset,
	});

	let visible = rows;
	if (viewer) {
		const blocked = await blockedAuthors(viewer, rows);
		if (blocked.size > 0) visible = rows.filter((row) => !blocked.has(row.did));
	}

	return {
		feed: visible.map((row) => ({ post: row.uri, reason: reasonFor(row) })),
		cursor: rows.length === limit ? String(offset + rows.length) : undefined,
	};
}
