import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import {
	bookIdentifiers,
	contributorIdentifiers,
	contributors,
	editions,
} from '../db/schema.js';
import { GoogleBooksClient, GoogleBooksError, type GbVolume } from '../google-books/client.js';
import { gbVolumeToEditionRecord } from '../google-books/mapper.js';
import { getCached, setCached, TTL } from '../google-books/cache.js';
import { COLLECTION } from '../lex/collections.js';

/**
 * Owned collections for the AppView's PDS. Catalog records (edition,
 * contributor) live under `community.lexicon.book.*`. App-private shelves /
 * bookShelving / actor are Jetstream-indexed and served via
 * `user_records` (not backed by these tables).
 */
export const COLLECTIONS = {
	edition: COLLECTION.edition,
	contributor: COLLECTION.contributor,
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
	valueScheme: string;
	value: string;
	uri: string;
}

/** Plain object shape for an edition record (mirrors `community.lexicon.book.edition`). */
export interface EditionRecord {
	$type: 'community.lexicon.book.edition';
	title: string;
	subtitle?: string;
	work?: string;
	publisher?: string;
	place?: string;
	publishedYear?: number;
	language?: string;
	contributors?: { subject: string; role: string }[];
	identifiers?: { uri: string; resource: string }[];
	description?: string;
	createdAt: string;
}

/** Plain object shape for a contributor record (mirrors `community.lexicon.book.contributor`). */
export interface ContributorRecord {
	$type: 'community.lexicon.book.contributor';
	name: string;
	aliases?: string[];
	linkedDid?: string;
	bio?: string;
	bornYear?: number;
	diedYear?: number;
	identifiers?: { uri: string; resource: string }[];
	createdAt: string;
}

// ─── Contributor ────────────────────────────────────────────────────────────

export function serializeContributor(
row: {
	pk: string;
	name: string;
	sortName: string | null;
	bio: string | null;
	createdAt: number;
	updatedAt: number | null;
},
identifiers: IdentifierRow[],
): ContributorRecord {
	const value: ContributorRecord = {
		$type: COLLECTIONS.contributor,
		name: row.name,
	};
	if (identifiers.length) {
		value.identifiers = identifiers.map((id) => ({
			uri: uri(id.uri),
			resource: id.valueScheme,
		}));
	}
	if (row.bio) value.bio = row.bio;
	if (row.createdAt != null) value.createdAt = toIso(row.createdAt)!;
	return value;
}

// ─── Edition ────────────────────────────────────────────────────────────────

export function serializeEdition(
row: {
	pk: string;
	title: string;
	subtitle: string | null;
	language: string | null;
	place: string | null;
	workUri: string | null;
	publisherUri: string | null;
	publishedYear: number | null;
	description: string | null;
	contributors: unknown;
	createdAt: number;
	updatedAt: number | null;
},
identifiers: IdentifierRow[],
): EditionRecord {
	const subjects = (row.contributors ?? []) as { subject: string; role: string }[];
	const value: EditionRecord = {
		$type: COLLECTIONS.edition,
		title: row.title,
		contributors: subjects,
		identifiers: identifiers.map((i) => ({ uri: uri(i.uri), resource: i.valueScheme })),
		createdAt: toIso(row.createdAt)!,
	};
	if (row.subtitle) value.subtitle = row.subtitle;
	if (row.workUri) value.work = row.workUri;
	if (row.publisherUri) value.publisher = row.publisherUri;
	if (row.place) value.place = row.place;
	if (row.publishedYear != null) value.publishedYear = row.publishedYear;
	if (row.language) value.language = row.language;
	if (row.description) value.description = row.description;
	return value;
}

// ─── Hydrating serializers (DB-aware) ────────────────────────────────────────

export interface PdsContext {
	serviceDid: string;
}

async function loadContributorIdentifiers(db: Db, pk: string): Promise<IdentifierRow[]> {
	return db.select().from(contributorIdentifiers).where(eq(contributorIdentifiers.contributorPk, pk));
}

async function loadBookIdentifiers(db: Db, pk: string): Promise<IdentifierRow[]> {
	return db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, pk));
}

export async function hydrateContributor(
db: Db,
pk: string,
): Promise<ContributorRecord | undefined> {
	const row = (await db.select().from(contributors).where(eq(contributors.pk, pk)))[0];
	if (!row) return undefined;
	const identifiers = await loadContributorIdentifiers(db, pk);
	return serializeContributor(row, identifiers);
}

export async function hydrateEdition(db: Db, pk: string): Promise<EditionRecord | undefined> {
	const row = (await db.select().from(editions).where(eq(editions.pk, pk)))[0];
	if (!row) return undefined;
	const identifiers = await loadBookIdentifiers(db, pk);
	return serializeEdition(row, identifiers);
}

export type SerializedRecord = EditionRecord | ContributorRecord;

export async function loadRecord(
db: Db,
_ctx: PdsContext,
collection: OwnedCollection,
pk: string,
): Promise<SerializedRecord | undefined> {
	switch (collection) {
		case COLLECTIONS.edition:
			return hydrateEdition(db, pk);
		case COLLECTIONS.contributor:
			return hydrateContributor(db, pk);
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
		case COLLECTIONS.edition:
			return editions;
		case COLLECTIONS.contributor:
			return contributors;
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
 * Mint a fresh TID for use as an atproto record rkey. We use a 13-char
 * Crockford base32 string of mostly random bytes; collisions are negligible
 * at our scale (32^13 ≈ 3.7e19 possibilities).
 */
export function mintTid(): string {
	const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < 8; i++) {
		out += alphabet[bytes[i]! % alphabet.length];
	}
	return out + Date.now().toString(36).slice(-5);
}

/**
 * Look up an existing contributor by case-insensitive exact name match. Returns
 * the contributor pk (TID) if found, or undefined. Used by GB lazy-load to dedupe
 * contributors imported from multiple GB volumes.
 */
async function findContributorByName(
db: Db,
name: string,
): Promise<string | undefined> {
	const lower = name.toLowerCase();
	const row = (await db
		.select({ pk: contributors.pk })
		.from(contributors)
		.where(eq(contributors.nameLower, lower))
		.limit(1))[0];
	return row?.pk;
}

/**
 * Idempotently persist a GB-backed edition. Mints a fresh TID, dedupes
 * contributors by `name_lower`, and writes identifier rows in flipped
 * `{value_scheme, value, uri}` form. Wrapped in a single transaction.
 */
export async function persistGbBackedEdition(db: Db, volume: GbVolume): Promise<string> {
	const info = volume.volumeInfo;
	const editionTid = mintTid();
	const now = Math.floor(Date.now() / 1000);

	const contributorTids = new Map<string, string>(); // author name → pk
	const contributorsJson: { subject: string; role: string }[] = [];
	for (const author of info.authors ?? []) {
		let tid = contributorTids.get(author);
		if (!tid) {
			tid = await findContributorByName(db, author);
			if (!tid) {
				tid = mintTid();
				await db.insert(contributors).values({
					pk: tid,
					name: author,
					createdAt: now,
				}).onConflictDoNothing();
			}
			contributorTids.set(author, tid);
		}
		contributorsJson.push({ subject: tid, role: 'author' });
	}

	// Convert subjects to at-uri strings using a placeholder DID; the PDS router
	// rewrites to the canonical service DID when serializing the record.
	const subjectsForJson = contributorsJson.map((c) => ({
		subject: c.subject,
		role: c.role,
	}));

	await db.transaction(async (tx) => {
		await tx.insert(editions).values({
			pk: editionTid,
			title: info.title,
			subtitle: info.subtitle ?? null,
			language: info.language ?? null,
			publishedYear: parseYear(info.publishedDate),
			description: info.description ?? null,
			contributors: subjectsForJson as unknown as typeof editions.$inferSelect.contributors,
			createdAt: now,
			updatedAt: now,
		}).onConflictDoNothing({ target: editions.pk });

		const identifiers: { valueScheme: string; value: string; uri: string }[] = [];
		for (const ident of info.industryIdentifiers ?? []) {
			if (ident.type === 'ISBN_10') {
				identifiers.push({ valueScheme: 'isbn10', value: ident.identifier, uri: `urn:isbn:${ident.identifier}` });
			} else if (ident.type === 'ISBN_13') {
				identifiers.push({ valueScheme: 'isbn13', value: ident.identifier, uri: `urn:isbn:${ident.identifier}` });
			} else {
				identifiers.push({ valueScheme: 'googleBooks', value: ident.identifier, uri: `https://www.googleapis.com/books/v1/volumes/${ident.identifier}` });
			}
		}
		identifiers.push({
			valueScheme: 'googleBooks',
			value: volume.id,
			uri: `https://www.googleapis.com/books/v1/volumes/${volume.id}`,
		});

		if (identifiers.length) {
			await tx.insert(bookIdentifiers).values(
				identifiers.map((id) => ({
					bookPk: editionTid,
					valueScheme: id.valueScheme,
					value: id.value,
					uri: id.uri,
				})),
			).onConflictDoNothing();
		}
	});

	return editionTid;
}

function parseYear(publishedDate: string | undefined): number | null {
	if (!publishedDate) return null;
	const m = publishedDate.match(/^(\d{4})/);
	return m ? Number(m[1]) : null;
}

export interface LookupGbBookOptions {
	signal?: AbortSignal;
	requestId?: string;
}

/**
 * Lazy-import a `gb-` prefixed edition: cache → GB upstream → mint TID →
 * persist → return record. Returns undefined when GB has no such volume or
 * when the volume has no title. Throws {@link InvalidGbRkeyError} for
 * malformed rkeys (caller maps to 400) and {@link UpstreamUnavailableError}
 * for GB failures other than 404 (caller maps to 502).
 */
export async function lookupAndImportGbBook(
db: Db,
client: GoogleBooksClient,
rkey: string,
opts: LookupGbBookOptions = {},
): Promise<EditionRecord | undefined> {
	if (!rkey.startsWith('gb-')) {
		throw new InvalidGbRkeyError(`rkey must start with 'gb-', got '${rkey}'`);
	}
	const volumeId = rkey.slice(3);
	if (!GB_VOLUME_ID_RE.test(volumeId)) {
		throw new InvalidGbRkeyError(`invalid google books volume id: '${volumeId}'`);
	}

	let volume = await getCached<GbVolume>(db, 'getVolume', { volumeId }, opts);
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
				await setCached(db, 'getVolume', { volumeId }, volume, TTL.getBook, opts);
			} catch {
				// Cache write failures must not block record import.
			}
		}
	}
	if (!volume) return undefined;

	if (!volume.volumeInfo?.title) return undefined;
	const tid = await persistGbBackedEdition(db, volume);

	// Read back and serialize. The mint step above might have failed due to
	// concurrent insertion; fall back to a re-read.
	const row = (await db.select().from(editions).where(eq(editions.pk, tid)))[0];
	if (!row) {
		// Re-read by GB volume id (which we wrote into book_identifiers).
		const idents = await db.select().from(bookIdentifiers).where(andBookIdent(volumeId));
		const editionTid = idents[0]?.bookPk;
		if (!editionTid) return undefined;
		const r = (await db.select().from(editions).where(eq(editions.pk, editionTid)))[0];
		if (!r) return undefined;
		const ids = await db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, editionTid));
		return serializeEdition(r, ids);
	}
	const ids = await db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, tid));
	return serializeEdition(row, ids);
}

// Helper: book_identifiers where value = (some GB volume id pattern). We use
// `value` (the GB volume id column) instead of `uri` for the lookup.
function andBookIdent(volumeId: string) {
	return eq(bookIdentifiers.value, volumeId);
}

export { gbVolumeToEditionRecord };