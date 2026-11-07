import { cidForLex } from "@atproto/lex-cbor";
import type { LexMap } from "@atproto/lex-data";
import { formatToWire, publishedDateFromYear, usableCoverUrl, type Contributor } from "./book-wire";
import { displayUrl, identifierFromLegacy, type Identifier, type LegacyIdentifier } from "./identifiers";

/**
 * The lexicon-shaped `community.lexicon.book.edition` record value.
 *
 * This is the ONLY place the edition record shape is written: the CID clients
 * receive is the CID of the record as the API serves it, so every writer that
 * changes a field living in the record (`identifiers`, `pages`, `description`,
 * `coverUrl`, …) recomputes it from here.
 *
 * Two things the storage layer keeps differently have to be supplied by the
 * caller:
 *
 * - `contributors` holds strongRefs (`{ subject: { uri, cid }, role }`) so a
 *   contributor record update is detectable, while `defs#contributor` inlines
 *   the name. Callers pass the expanded entries (`book-wire`'s
 *   `wireContributors`).
 * - `place` / `publishedYear` / `coverImageUrl` are column names; the record
 *   carries `publishedDate` (precision-preserving) and `coverUrl`.
 */

/**
 * What an edition record value needs off a stored row. Satisfied by both an
 * `editions` row and an ingested `EditionItem`, so ingest and the backfills
 * cannot build two shapes.
 */
export interface EditionValueSource {
	title: string;
	identifiers?: unknown;
	createdAt: Date | string;
	subtitle?: string | null;
	language?: string | null;
	publishedYear?: number | null;
	format?: string | null;
	pages?: number | null;
	description?: string | null;
	coverImageUrl?: string | null;
}

export interface EditionRecordOverrides {
	/** `defs#contributor` entries, expanded from the stored strongRefs. */
	contributors: readonly Contributor[];
	identifiers?: readonly Identifier[];
	pages?: number | null;
	publishedYear?: number | null;
	language?: string | null;
	format?: string | null;
	coverUrl?: string | null;
	description?: string | null;
}

/**
 * Stored identifiers are canonical (`{ type, value, url? }`) after the
 * migration; rows written before it still hold the legacy pair (a `uri` plus a
 * provider token), so the old shape is converted here rather than trusted.
 */
export function rowIdentifiers(raw: unknown): Identifier[] {
	if (!Array.isArray(raw)) return [];
	const out: Identifier[] = [];
	for (const entry of raw as Array<Identifier | LegacyIdentifier>) {
		if (!entry || typeof entry !== "object") continue;
		if ("type" in entry && "value" in entry) {
			const url = displayUrl(entry.url);
			out.push(url === undefined ? { type: entry.type, value: entry.value } : { type: entry.type, value: entry.value, url });
		} else if ("uri" in entry) {
			out.push(identifierFromLegacy(entry));
		}
	}
	return out;
}

/**
 * Build the record value. Returns `null` when the edition carries no
 * identifiers: the lexicon requires at least one, so there is no valid record
 * to hash and the caller must skip the write rather than persist an empty list.
 */
export function editionRecordValue(
	row: EditionValueSource,
	overrides: EditionRecordOverrides,
): Record<string, unknown> | null {
	const identifiers = overrides.identifiers ? [...overrides.identifiers] : rowIdentifiers(row.identifiers);
	if (identifiers.length === 0) return null;

	const value: Record<string, unknown> = {
		$type: "community.lexicon.book.edition" as const,
		title: row.title,
		identifiers,
		contributors: overrides.contributors,
		createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString(),
	};
	if (row.subtitle) value.subtitle = row.subtitle;

	const language = overrides.language === undefined ? row.language : overrides.language;
	if (language) value.language = language;

	const year = overrides.publishedYear === undefined ? row.publishedYear : overrides.publishedYear;
	const publishedDate = publishedDateFromYear(year);
	if (publishedDate) value.publishedDate = publishedDate;

	const storedFormat = overrides.format === undefined ? row.format : overrides.format;
	const format = formatToWire(storedFormat ?? undefined);
	if (format) value.format = format;

	const pages = overrides.pages === undefined ? row.pages : overrides.pages;
	if (pages !== null && pages !== undefined) value.pages = pages;

	const coverUrl = usableCoverUrl(overrides.coverUrl === undefined ? row.coverImageUrl : overrides.coverUrl);
	if (coverUrl) value.coverUrl = coverUrl;

	const description = overrides.description === undefined ? row.description : overrides.description;
	if (description) value.description = description;

	return value;
}

/** {@link editionRecordValue}'s CID, or `null` when there is no valid value. */
export async function editionRecordCid(
	row: EditionValueSource,
	overrides: EditionRecordOverrides,
): Promise<string | null> {
	const value = editionRecordValue(row, overrides);
	if (!value) return null;
	return (await cidForLex(value as unknown as LexMap)).toString();
}
