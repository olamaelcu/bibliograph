import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import type * as Lexicons from '../lexicons/index.js';

type Book = Lexicons.NetOlamaelcuLivtetBiblioBook.Main;
type Work = Lexicons.NetOlamaelcuLivtetBiblioWork.Main;
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
	workIdentifiers,
	works,
} from '../db/schema.js';
import { releasedFilter } from '../xrpc/gate.js';

export const COLLECTIONS = {
	work: 'net.olamaelcu.livtet.biblio.work',
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

// ─── Work ───────────────────────────────────────────────────────────────────

export function serializeWork(
	row: {
		pk: string;
		title: string;
		description: string | null;
		originalPublishDate: number | null;
		createdAt: number;
	},
	identifiers: IdentifierRow[],
): Work {
	const value: Work = {
		$type: 'net.olamaelcu.livtet.biblio.work',
		title: row.title,
	};
	if (identifiers.length) {
		value.identifiers = identifiers.map((id) => ({
			resource: id.resource,
			url: uri(id.url),
		}));
	}
	if (row.description) value.description = row.description;
	if (row.originalPublishDate != null) value.originalPublishDate = toIso(row.originalPublishDate);
	if (row.createdAt != null) value.createdAt = toIso(row.createdAt);
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
	work?: { pk: string; title: string; description: string | null; originalPublishDate: number | null; createdAt: number };
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
	if (opts.work) {
		value.work = serializeWork(opts.work, []);
	}
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

export async function hydrateWork(db: Db, pk: string): Promise<Work | undefined> {
	const row = (await db.select().from(works).where(and(eq(works.pk, pk), releasedFilter(works))))[0];
	if (!row) return undefined;
	const identifiers = await loadIdentifiers(db, workIdentifiers, workIdentifiers.workPk, pk);
	return serializeWork(row, identifiers);
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

	const work = row.workPk
		? (await db.select().from(works).where(eq(works.pk, row.workPk)))[0]
		: undefined;
	const format = row.formatPk
		? (await db.select().from(formats).where(eq(formats.pk, row.formatPk)))[0]
		: undefined;

	return serializeBook(row, {
		serviceDid: ctx.serviceDid,
		work,
		format,
		genres: genreRows.map((j) => j.genre),
		identifiers: identifierRows,
	});
}

export type SerializedRecord = Book | Contributor | ContributorRole | Format | Genre | Work;

export async function loadRecord(
	db: Db,
	ctx: PdsContext,
	collection: OwnedCollection,
	pk: string,
): Promise<SerializedRecord | undefined> {
	switch (collection) {
		case COLLECTIONS.book:
			return hydrateBook(db, ctx, pk);
		case COLLECTIONS.work:
			return hydrateWork(db, pk);
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
		case COLLECTIONS.work:
			return works;
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
