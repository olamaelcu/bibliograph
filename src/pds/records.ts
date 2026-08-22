import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import type * as Lexicons from '../lexicons/index.js';

type Book = Lexicons.NetOlamaelcuLivtetBiblioBook.Main;
type Contributor = Lexicons.NetOlamaelcuLivtetBiblioContributor.Main;
type ContributorRole = Lexicons.NetOlamaelcuLivtetBiblioContributorRole.Main;
type Format = Lexicons.NetOlamaelcuLivtetBiblioFormat.Main;
type Genre = Lexicons.NetOlamaelcuLivtetBiblioGenre.Main;
import {
	contributors,
	contributorIdentifiers,
	bookContributors,
	bookGenres,
	bookIdentifiers,
	books,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
} from '../db/schema.js';
import { releasedFilter } from '../xrpc/gate.js';
import { GoogleBooksClient, GoogleBooksError, type GbVolume } from '../google-books/client.js';
import { gbVolumeToBookRecord } from '../google-books/mapper.js';
import { getCached, setCached, TTL } from '../google-books/cache.js';

export const COLLECTIONS = {
	book: 'net.olamaelcu.livtet.biblio.book',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	contributorRole: 'net.olamaelcu.livtet.biblio.contributorRole',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
} as const;

export type OwnedCollection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export function isOwnedCollection(value: string): value is OwnedCollection {
	return Object.values(COLLECTIONS).includes(value as OwnedCollection);
}

type Db = NodePgDatabase<typeof schema>;

export interface RecordWithCid {
	cid: string;
}

function toIso(seconds: number | null | undefined): string | undefined {
	return seconds == null ? undefined : new Date(seconds * 1000).toISOString();
}

type Uri = `${string}:${string}`;

function uri(value: string): Uri {
	return value as Uri;
}

export interface IdentifierRow {
	resource: string;
	url: string;
}

// ─── Format ─────────────────────────────────────────────────────────────────

export function serializeFormat(row: {
	pk: string;
	description: string;
	emoji: string;
	iconImageUrl: string | null;
	unit: string;
}): Format {
	const value: Format = {
		$type: 'net.olamaelcu.livtet.biblio.format',
		description: row.description,
		emoji: row.emoji,
		unit: row.unit,
	};
	if (row.iconImageUrl) value.iconImageUrl = uri(row.iconImageUrl);
	return value;
}

// ─── Genre ──────────────────────────────────────────────────────────────────

export function serializeGenre(
	ctx: { serviceDid: string },
	row: {
		pk: string;
		name: string;
		emoji: string;
		description: string;
		iconImageUrl: string | null;
		parentPk: string | null;
	},
	identifiers: IdentifierRow[],
): Genre {
	const value: Genre = {
		$type: 'net.olamaelcu.livtet.biblio.genre',
		name: row.name,
		emoji: row.emoji,
		description: row.description,
	};
	if (row.iconImageUrl) value.iconImageUrl = uri(row.iconImageUrl);
	if (identifiers.length) {
		value.identifiers = identifiers.map((id) => ({
			resource: id.resource,
			url: uri(id.url),
		}));
	}
	if (row.parentPk) {
		value.parent = `at://${ctx.serviceDid}/${COLLECTIONS.genre}/${row.parentPk}` as Genre['parent'];
	}
	return value;
}

// ─── Contributor ────────────────────────────────────────────────────────────

export function serializeContributor(
	row: {
		pk: string;
		name: string;
		sortName: string | null;
		bio: string | null;
		imageUrl: string | null;
		createdAt: number;
	},
	identifiers: IdentifierRow[],
): Contributor {
	const value: Contributor = {
		$type: 'net.olamaelcu.livtet.biblio.contributor',
		name: row.name,
	};
	if (row.sortName) value.sortName = row.sortName;
	if (identifiers.length) {
		value.identifiers = identifiers.map((id) => ({
			resource: id.resource,
			url: uri(id.url),
		}));
	}
	if (row.bio) value.bio = row.bio;
	if (row.imageUrl) value.imageUrl = uri(row.imageUrl);
	if (row.createdAt != null) value.createdAt = toIso(row.createdAt);
	return value;
}

// ─── Contributor Role ───────────────────────────────────────────────────────

export function serializeContributorRole(row: {
	pk: string;
	name: string;
	description: string;
	iconImageUrl: string | null;
	createdAt: number;
}): ContributorRole {
	const value: ContributorRole = {
		$type: 'net.olamaelcu.livtet.biblio.contributorRole',
		name: row.name,
		description: row.description,
	};
	if (row.iconImageUrl) value.iconImageUrl = uri(row.iconImageUrl);
	if (row.createdAt != null) value.createdAt = toIso(row.createdAt);
	return value;
}

// ─── Book ───────────────────────────────────────────────────────────────────

export interface SerializeBookOptions {
	serviceDid: string;
	format?: { pk: string; description: string; emoji: string; iconImageUrl: string | null; unit: string };
	genres?: Array<{ pk: string; name: string; emoji: string; description: string; iconImageUrl: string | null; parentPk: string | null }>;
	identifiers?: IdentifierRow[];
}

export function serializeBook(
	row: {
		pk: string;
		title: string;
		publishDate: number | null;
		description: string | null;
		coverUrl: string | null;
		createdAt: number;
	},
	opts: SerializeBookOptions,
): Book {
	const value: Book = {
		$type: 'net.olamaelcu.livtet.biblio.book',
		title: row.title,
	};
	if (opts.format) {
		value.format = serializeFormat(opts.format);
	}
	if (opts.genres?.length) {
		value.genres = opts.genres.map((g) =>
			serializeGenre({ serviceDid: opts.serviceDid }, g, []),
		);
	}
	if (opts.identifiers?.length) {
		value.identifiers = opts.identifiers.map((id) => ({
			resource: id.resource,
			url: uri(id.url),
		}));
	}
	if (row.publishDate != null) value.publishDate = toIso(row.publishDate);
	if (row.description) value.description = row.description;
	if (row.coverUrl) value.coverUrl = uri(row.coverUrl);
	if (row.createdAt != null) value.createdAt = toIso(row.createdAt);
	return value;
}

// ─── Hydrating serializers (DB-aware) ────────────────────────────────────────

export interface PdsContext {
	serviceDid: string;
}

async function loadIdentifiers(db: Db, table: any, pkCol: any, pk: string): Promise<IdentifierRow[]> {
	const rows = (await db.select().from(table).where(eq(pkCol, pk))) as IdentifierRow[];
	return rows;
}

export async function hydrateFormat(db: Db, pk: string) {
	const row = (await db.select().from(formats).where(eq(formats.pk, pk)))[0];
	return row ? serializeFormat(row) : undefined;
}

export async function hydrateGenre(
	db: Db,
	ctx: PdsContext,
	pk: string,
): Promise<Genre | undefined> {
	const row = (await db.select().from(genres).where(and(eq(genres.pk, pk), releasedFilter(genres))))[0];
	if (!row) return undefined;
	const identifiers = await loadIdentifiers(db, genreIdentifiers, genreIdentifiers.genrePk, pk);
	return serializeGenre(ctx, row, identifiers);
}

export async function hydrateContributor(
	db: Db,
	pk: string,
): Promise<Contributor | undefined> {
	const row = (await db.select().from(contributors).where(and(eq(contributors.pk, pk), releasedFilter(contributors))))[0];
	if (!row) return undefined;
	const identifiers = await loadIdentifiers(db, contributorIdentifiers, contributorIdentifiers.contributorPk, pk);
	return serializeContributor(row, identifiers);
}

export async function hydrateContributorRole(db: Db, pk: string) {
	const row = (await db.select().from(contributorRoles).where(and(eq(contributorRoles.pk, pk), releasedFilter(contributorRoles))))[0];
	return row ? serializeContributorRole(row) : undefined;
}

export async function hydrateBook(db: Db, ctx: PdsContext, pk: string): Promise<Book | undefined> {
	const row = (await db.select().from(books).where(and(eq(books.pk, pk), releasedFilter(books))))[0];
	if (!row) return undefined;

	const [genreRows, identifierRows] = await Promise.all([
		db
			.select({ genre: genres })
			.from(bookGenres)
			.innerJoin(genres, eq(bookGenres.genrePk, genres.pk))
			.where(eq(bookGenres.bookPk, pk)),
		loadIdentifiers(db, bookIdentifiers, bookIdentifiers.bookPk, pk),
	]);

	const format = row.formatPk
		? (await db.select().from(formats).where(eq(formats.pk, row.formatPk)))[0]
		: undefined;

	return serializeBook(row, {
		serviceDid: ctx.serviceDid,
		format,
		genres: genreRows.map((j) => j.genre),
		identifiers: identifierRows,
	});
}

export type SerializedRecord = Book | Contributor | ContributorRole | Format | Genre;

export async function loadRecord(
	db: Db,
	ctx: PdsContext,
	collection: OwnedCollection,
	pk: string,
): Promise<SerializedRecord | undefined> {
	switch (collection) {
		case COLLECTIONS.book:
			return hydrateBook(db, ctx, pk);
		case COLLECTIONS.contributor:
			return hydrateContributor(db, pk);
		case COLLECTIONS.contributorRole:
			return hydrateContributorRole(db, pk);
		case COLLECTIONS.format:
			return hydrateFormat(db, pk);
		case COLLECTIONS.genre:
			return hydrateGenre(db, ctx, pk);
	}
}

/** Load a stored CID for a record, if one has been persisted. */
export async function loadCid(db: Db, collection: OwnedCollection, pk: string): Promise<string | undefined> {
	const table = tableFor(collection);
	const row = (await db.select({ cid: table.cid }).from(table).where(eq(table.pk, pk)))[0];
	return row?.cid || undefined;
}

export async function persistCid(
	db: Db,
	collection: OwnedCollection,
	pk: string,
	cid: string,
): Promise<void> {
	const table = tableFor(collection);
	await db.update(table).set({ cid }).where(eq(table.pk, pk));
}

function tableFor(collection: OwnedCollection) {
	switch (collection) {
		case COLLECTIONS.book:
			return books;
		case COLLECTIONS.contributor:
			return contributors;
		case COLLECTIONS.contributorRole:
			return contributorRoles;
		case COLLECTIONS.format:
			return formats;
		case COLLECTIONS.genre:
			return genres;
	}
}

// ─── Lazy GB-backed import ──────────────────────────────────────────────────────────

const GB_VOLUME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidGbRkeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidGbRkeyError';
	}
}

export class UpstreamUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UpstreamUnavailableError';
	}
}

/**
 * Idempotently write a GB-backed book row and its identifier rows. Wrapped in a
 * single transaction so a half-written state can never appear. ON CONFLICT DO
 * NOTHING on both inserts makes concurrent first-time imports safe: the losing
 * insert is a no-op and the caller re-reads from the DB if it needs the
 * canonical row.
 *
 * Release status is forced to 'released' so the row is visible to subsequent
 * hydrateBook calls (which apply releasedFilter) and to AppView join queries
 * like getBookOnShelf. GB data is canonical and skips the importer review
 * lifecycle.
 */
export async function persistGbBackedBook(db: Db, value: Book, pk: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.transaction(async (tx) => {
		await tx
			.insert(books)
			.values({
				pk,
				title: value.title,
				publishDate: value.publishDate ? Math.floor(Date.parse(value.publishDate) / 1000) : null,
				description: value.description ?? null,
				coverUrl: value.coverUrl ?? null,
				createdAt: now,
				updatedAt: null,
				releaseStatus: 'released',
				releasedAt: now,
			})
			.onConflictDoNothing({ target: books.pk });

		if (value.identifiers?.length) {
			await tx
				.insert(bookIdentifiers)
				.values(
					value.identifiers.map((id) => ({
						bookPk: pk,
						resource: id.resource,
						url: id.url,
					})),
				)
				.onConflictDoNothing();
		}
	});
}

export interface LookupGbBookOptions {
	signal?: AbortSignal;
	requestId?: string;
}

/**
 * Lazy-import a `gb-` prefixed book: cache → GB upstream → map → persist →
 * return. Returns undefined when GB has no such volume or when the volume has
 * no title. Throws {@link InvalidGbRkeyError} for malformed rkeys (caller maps
 * to 400) and {@link UpstreamUnavailableError} for GB failures other than 404
 * (caller maps to 502).
 */
export async function lookupAndImportGbBook(
	db: Db,
	client: GoogleBooksClient,
	rkey: string,
	opts: LookupGbBookOptions = {},
): Promise<Book | undefined> {
	if (!rkey.startsWith('gb-')) {
		throw new InvalidGbRkeyError(`rkey must start with 'gb-', got '${rkey}'`);
	}
	const volumeId = rkey.slice(3);
	if (!GB_VOLUME_ID_RE.test(volumeId)) {
		throw new InvalidGbRkeyError(`invalid google books volume id: '${volumeId}'`);
	}

	let volume = await getCached<GbVolume>(db, 'getBook', { volumeId }, opts);
	if (!volume) {
		try {
			volume = (await client.getVolume(volumeId, opts)) ?? undefined;
		} catch (err) {
			if (err instanceof GoogleBooksError && err.status === 404) return undefined;
			throw new UpstreamUnavailableError(
				err instanceof GoogleBooksError
					? `google books returned ${err.status}`
					: 'google books request failed',
			);
		}
		if (volume) {
			try {
				await setCached(db, 'getBook', { volumeId }, volume, TTL.getBook, opts);
			} catch {
				// Cache write failures must not block record import.
			}
		}
	}
	if (!volume) return undefined;

	const value = gbVolumeToBookRecord(volume);
	if (!value) return undefined;

	await persistGbBackedBook(db, value, rkey);
	return value;
}
