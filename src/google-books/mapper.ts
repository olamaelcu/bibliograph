import type { GbVolume, GbVolumeInfo } from './client.js';
import type { ViewContext } from '../lex/collections.js';
import { COLLECTION } from '../lex/collections.js';

/**
 * Convert a GB `industryIdentifiers` array to the community `{uri, resource}`
 * identifier shape. ISBNs become URN-style URIs; everything else stays
 * vendor-URL.
 */
export function gbIdentifiersToIdentifiers(info: GbVolumeInfo): { uri: string; resource: string }[] {
	const items: { uri: string; resource: string }[] = [];
	if (info.industryIdentifiers) {
		for (const ident of info.industryIdentifiers) {
			if (ident.type === 'ISBN_10') {
				items.push({ uri: `urn:isbn:${ident.identifier}`, resource: 'isbn10' });
			} else if (ident.type === 'ISBN_13') {
				items.push({ uri: `urn:isbn:${ident.identifier}`, resource: 'isbn13' });
			} else {
				items.push({ uri: `https://www.googleapis.com/books/v1/volumes/${ident.identifier}`, resource: 'googleBooks' });
			}
		}
	}
	return items;
}

/**
 * Mint an author slug from a name. Lowercases, strips diacritics, replaces
 * non-alphanumerics with `-`. Empty/Unicode-only names fall back to a
 * deterministic FNV-1a hash prefixed with `c-`. Used only for ephemeral
 * slug generation in test fixtures.
 */
export function gbAuthorSlugToName(slug: string): string {
	const match = slug.match(/^gbauthors-(?:xn-([a-z0-9]+)|(.+))$/);
	if (!match) throw new Error(`not a gbauthor slug: ${slug}`);
	const body = match[1] ?? match[2] ?? '';
	return body.replace(/-/g, ' ');
}

/** Opaque cursor encoding `{ q, startIndex }` for `searchEditions`. */
export interface GbCursor {
	q: string;
	startIndex: number;
}

export function encodeGbCursor(cursor: GbCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeGbCursor(value: string | undefined): GbCursor | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof (parsed as GbCursor).q === 'string' &&
			typeof (parsed as GbCursor).startIndex === 'number'
		) {
			return { q: (parsed as GbCursor).q, startIndex: (parsed as GbCursor).startIndex };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Map a Google Books volume to a `community.lexicon.book.edition` AppView
 * record (the shape persisted by GB lazy-load and returned by AppView
 * queries). Returns undefined when the volume has no title.
 *
 * The returned record carries a synthetic `uri` of the form
 * `at://<serviceDid>/community.lexicon.book.edition/gb-<volumeId>` so that
 * search results can be followed up by `getEdition(uri)` without a
 * separate indexing step. `getEdition` recognises the `gb-` rkey prefix
 * and lazily fetches the volume on first call.
 *
 * `subject` in `contributors[]` is encoded as just the contributor TID
 * rkey here; the PDS router rewrites to a full at-uri at serialization
 * time using the service DID.
 */
export function gbVolumeToEditionRecord(
  ctx: ViewContext,
  volume: GbVolume,
): Record<string, unknown> | undefined {
  const info = volume.volumeInfo;
  if (!info?.title) return undefined;
  const record: Record<string, unknown> = {
    $type: COLLECTION.edition,
    uri: `at://${ctx.serviceDid}/${COLLECTION.edition}/gb-${volume.id}`,
    title: info.title,
    createdAt: new Date().toISOString(),
  };
  if (info.subtitle) record.subtitle = info.subtitle;
  if (info.publishedDate) {
    const year = parseYear(info.publishedDate);
    if (year != null) record.publishedYear = year;
  }
  if (info.description) record.description = info.description;
  if (info.authors?.length) {
    record.contributors = info.authors.map((name) => ({ name, role: 'author' }));
  }
  const identifiers = gbIdentifiersToIdentifiers(info);
  if (identifiers.length) record.identifiers = identifiers;
  return record;
}

function parseYear(publishedDate: string): number | undefined {
	const m = publishedDate.match(/^(\d{4})/);
	return m ? Number(m[1]) : undefined;
}