import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { PUBLISHER_DID } from '../did';
import { identifierKey, uniqueIdentifiers, type Identifier } from '../identifiers';
import type { AppviewBookRow, EditionInput } from './types';

export const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

export function editionUriForRkey(rkey: string): string {
	return `at://${PUBLISHER_DID}/${EDITION_COLLECTION}/${rkey}`;
}

function rowsOf<T>(result: unknown): T[] {
	return (result as { rows?: T[] }).rows ?? [];
}

function jsonParam(value: unknown): SQL {
	return sql`${JSON.stringify(value)}::jsonb`;
}

function identifierPairs(identifiers: readonly Identifier[]): SQL {
	return sql.join(
		identifiers.map((identifier) => sql`(${identifier.issuer}::text, ${identifier.value}::text)`),
		sql`, `,
	);
}

/** The edition a stored identifier pair already names, if any. */
export async function editionUriForIdentifiers(identifiers: readonly Identifier[]): Promise<string | undefined> {
	const unique = uniqueIdentifiers(identifiers);
	if (unique.length === 0) return undefined;
	const rows = rowsOf<{ edition_uri: string }>(
		await db.execute(sql`
			SELECT edition_uri FROM edition_identifiers
			WHERE (issuer, value) IN (${identifierPairs(unique)})
			LIMIT 1
		`),
	);
	return rows[0]?.edition_uri;
}

async function upsertContributor(name: string, identifiers: Identifier[]): Promise<number> {
	const trimmed = name.trim();
	const inserted = rowsOf<{ id: number }>(
		await db.execute(sql`
			INSERT INTO contributors (name, identifiers)
			VALUES (${trimmed}, ${jsonParam(identifiers)})
			ON CONFLICT DO NOTHING
			RETURNING id
		`),
	);
	if (inserted[0]) return Number(inserted[0].id);
	const existing = rowsOf<{ id: number }>(
		await db.execute(sql`
			SELECT id FROM contributors
			WHERE lower(name) = lower(${trimmed}) AND identifiers = ${jsonParam(identifiers)}
			LIMIT 1
		`),
	);
	if (!existing[0]) throw new Error(`contributor upsert found no row for ${trimmed}`);
	return Number(existing[0].id);
}

async function upsertPublisher(name: string, identifiers: Identifier[]): Promise<number> {
	const trimmed = name.trim();
	const inserted = rowsOf<{ id: number }>(
		await db.execute(sql`
			INSERT INTO publishers (name, identifiers)
			VALUES (${trimmed}, ${jsonParam(identifiers)})
			ON CONFLICT DO NOTHING
			RETURNING id
		`),
	);
	if (inserted[0]) return Number(inserted[0].id);
	const existing = rowsOf<{ id: number }>(
		await db.execute(sql`
			SELECT id FROM publishers
			WHERE lower(name) = lower(${trimmed}) AND identifiers = ${jsonParam(identifiers)}
			LIMIT 1
		`),
	);
	if (!existing[0]) throw new Error(`publisher upsert found no row for ${trimmed}`);
	return Number(existing[0].id);
}

/**
 * Insert or update one edition and its child rows.
 *
 * Identity is the identifier bag: when any stored pair already names an
 * edition, that row is updated in place and keeps its rkey/uri, so a client
 * that saved the URI keeps resolving. Otherwise a fresh TID is minted. The
 * outbox triggers on `editions` and the child tables publish the result.
 */
export async function upsertEdition(input: EditionInput): Promise<string | null> {
	const identifiers = uniqueIdentifiers(input.identifiers);
	if (identifiers.length === 0) return null;

	const existingUri = await editionUriForIdentifiers(identifiers);
	let uri = existingUri;
	let rkey: string;
	if (existingUri) {
		rkey = existingUri.slice(existingUri.lastIndexOf('/') + 1);
	} else {
		const minted = rowsOf<{ rkey: string }>(await db.execute(sql`SELECT editions_next_tid() AS rkey`));
		rkey = minted[0]!.rkey;
		uri = editionUriForRkey(rkey);
	}
	const target = uri!;

	await db.execute(sql`
		INSERT INTO editions (
			uri, rkey, title, subtitle, language, published_date, format, pages,
			duration_seconds, chapters, series, book_edition,
			description, cover_url, created_at, indexed_at
		) VALUES (
			${target}, ${rkey}, ${input.title}, ${input.subtitle ?? null}, ${input.language ?? null},
			${input.publishedDate ?? null}, ${input.format ?? null}, ${input.pages ?? null},
			${input.durationSeconds ?? null}, ${input.chapters ?? null}, ${input.series ?? null},
			${input.series ? JSON.stringify(input.series) : null}::jsonb, ${input.bookEdition ?? null}, ${input.description ?? null},
			${input.coverUrl ?? null}, ${input.createdAt}, now()
		)
		ON CONFLICT (uri) DO UPDATE SET
			title = excluded.title,
			subtitle = excluded.subtitle,
			language = excluded.language,
			published_date = excluded.published_date,
			format = excluded.format,
			pages = excluded.pages,
			duration_seconds = excluded.duration_seconds,
			chapters = excluded.chapters,
			series = excluded.series,
			book_edition = excluded.book_edition,
			description = excluded.description,
			cover_url = excluded.cover_url,
			indexed_at = now()
	`);

	await db.execute(sql`
		DELETE FROM edition_identifiers
		WHERE edition_uri = ${target}
		  AND (issuer, value) NOT IN (${identifierPairs(identifiers)})
	`);
	for (const identifier of identifiers) {
		await db.execute(sql`
			INSERT INTO edition_identifiers (edition_uri, issuer, value)
			VALUES (${target}, ${identifier.issuer}, ${identifier.value})
			ON CONFLICT DO NOTHING
		`);
	}

	await db.execute(sql`DELETE FROM edition_contributors WHERE edition_uri = ${target}`);
	let position = 1;
	for (const contributor of input.contributors) {
		const name = contributor.name.trim();
		if (!name) continue;
		const contributorId = await upsertContributor(name, contributor.identifiers ?? []);
		await db.execute(sql`
			INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
			VALUES (${target}, ${contributorId}, ${position}, ${contributor.role ?? 'author'}, ${contributor.ref ?? null})
		`);
		position += 1;
	}

	await db.execute(sql`DELETE FROM edition_publishers WHERE edition_uri = ${target}`);
	if (input.publisher?.name.trim()) {
		const publisherId = await upsertPublisher(input.publisher.name, input.publisher.identifiers ?? []);
		await db.execute(sql`
			INSERT INTO edition_publishers (edition_uri, publisher_id, position)
			VALUES (${target}, ${publisherId}, 1)
		`);
	}

	return target;
}

/** Ingest a batch, swallowing per-item failures so one bad row cannot block the rest. */
export async function upsertEditions(
	items: readonly EditionInput[],
	log?: { warn: (obj: object, msg: string) => void },
): Promise<string[]> {
	const uris: string[] = [];
	for (const item of items) {
		try {
			const uri = await upsertEdition(item);
			if (uri) uris.push(uri);
		} catch (err) {
			log?.warn({ err, title: item.title }, 'edition upsert failed; continuing');
		}
	}
	return uris;
}

/** Load `appview_book` rows by URI. */
export async function loadAppviewBooks(uris: readonly string[]): Promise<AppviewBookRow[]> {
	if (uris.length === 0) return [];
	const list = sql.join(uris.map((uri) => sql`${uri}`), sql`, `);
	return rowsOf<AppviewBookRow>(await db.execute(sql`SELECT * FROM appview_book WHERE uri IN (${list})`));
}

export async function loadAppviewBook(uri: string): Promise<AppviewBookRow | null> {
	const rows = await loadAppviewBooks([uri]);
	return rows[0] ?? null;
}

/** Load rows preserving the caller's order and dropping unknown URIs. */
export async function loadAppviewBooksOrdered(uris: readonly string[]): Promise<AppviewBookRow[]> {
	const unique = Array.from(new Set(uris));
	const rows = await loadAppviewBooks(unique);
	const byUri = new Map(rows.map((row) => [row.uri, row]));
	return unique.flatMap((uri) => {
		const row = byUri.get(uri);
		return row ? [row] : [];
	});
}

export interface EditionSearchQuery {
	titleText?: string;
	author?: string;
	identifiers?: readonly Identifier[];
	offset?: number;
	limit?: number;
}

export interface EditionSearchResult {
	rows: AppviewBookRow[];
	hasMore: boolean;
	total?: number;
}

function searchPredicates(query: EditionSearchQuery): SQL[] {
	const predicates: SQL[] = [];
	if (query.titleText) predicates.push(sql`b.title ILIKE ${`%${query.titleText}%`}`);
	if (query.author) {
		predicates.push(sql`EXISTS (
			SELECT 1 FROM edition_contributors ec
			JOIN contributors c ON c.id = ec.contributor_id
			WHERE ec.edition_uri = b.uri AND c.name ILIKE ${`%${query.author}%`}
		)`);
	}
	const identifiers = query.identifiers ? uniqueIdentifiers(query.identifiers) : [];
	if (identifiers.length > 0) {
		predicates.push(sql`EXISTS (
			SELECT 1 FROM edition_identifiers i
			WHERE i.edition_uri = b.uri AND (i.issuer, i.value) IN (${identifierPairs(identifiers)})
		)`);
	}
	return predicates;
}

/** `community.lexicon.media.book.searchEditions` / `resolveEditions`, catalog-only. */
export async function searchEditionRows(query: EditionSearchQuery): Promise<EditionSearchResult> {
	const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
	const offset = Math.max(query.offset ?? 0, 0);
	const predicates = searchPredicates(query);
	if (predicates.length === 0) return { rows: [], hasMore: false, total: 0 };
	const where = sql.join(predicates, sql` AND `);

	const rows = rowsOf<AppviewBookRow>(
		await db.execute(sql`
			SELECT b.* FROM appview_book b
			WHERE ${where}
			ORDER BY b.created_at DESC, b.uri ASC
			LIMIT ${limit + 1} OFFSET ${offset}
		`),
	);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);

	let total: number | undefined;
	if (offset === 0) {
		const counted = rowsOf<{ count: string }>(
			await db.execute(sql`SELECT count(*)::text AS count FROM appview_book b WHERE ${where}`),
		);
		total = Number(counted[0]?.count ?? 0);
	}
	return { rows: page, hasMore, total };
}

/** The edition's stored cover URL, when the row exists. */
export async function coverUrlForEdition(uri: string): Promise<string | null | undefined> {
	const rows = rowsOf<{ cover_url: string | null }>(
		await db.execute(sql`SELECT cover_url FROM editions WHERE uri = ${uri} LIMIT 1`),
	);
	return rows[0]?.cover_url ?? undefined;
}

/** Dedupe helper shared by the identifier-aware filters. */
export function identifierKeys(identifiers: readonly Identifier[]): string[] {
	return uniqueIdentifiers(identifiers).map(identifierKey);
}
