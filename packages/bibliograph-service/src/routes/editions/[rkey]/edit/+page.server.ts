import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { editions, editionIsbnEnrichment, type EditionRow } from '$lib/server/db/schema';
import { editionRecordCid, rowIdentifiers } from '$lib/server/edition-record';
import { resolveEditions } from '$lib/server/edition-lookup';
import { editionUriForRkey } from '$lib/server/edition-work-votes';
import { PUBLISHER_DID } from '$lib/server/did';
import { wireContributors } from '$lib/server/book-wire';
import { contributorUrisFor, loadContributorRefs } from '$lib/server/contributor-refs';
import {
  GLOBAL_IDENTIFIER_TOKENS,
  identifierFromString,
  identifierTypeForResource,
  isbnIdentifier,
  providerIdentifier,
  uniqueIdentifiers,
  type Identifier,
} from '$lib/server/identifiers';
import { MAX_IDENTIFIERS } from '$lib/server/isbn/merge';
import { isLibrarian } from '$lib/server/labeler/labels';
import {
  enqueueCoverBackfill,
  enqueueDescriptionBackfill,
  enqueueIsbnBackfill,
} from '$lib/server/jobs/enqueue';
import type { Actions, PageServerLoad } from './$types';

/** `identifier.type` is a global token (`isbn`, …) or a provider domain. */
const TYPE_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

function editPath(rkey: string): string {
  return `/editions/${rkey}/edit`;
}

/**
 * Mirrors `requireAdmin`: anonymous visitors sign in and come back, accounts
 * without the labeler's `librarian` label get a 403. The nav link is a
 * convenience; a hand-typed URL must hit the same wall.
 */
async function requireLibrarian(
  viewer: { did: string; handle: string | null } | null | undefined,
  next: string,
): Promise<string> {
  if (!viewer) redirect(303, `/login?next=${encodeURIComponent(next)}`);
  if (!(await isLibrarian(viewer.did))) {
    error(403, 'Only accounts holding the librarian label can edit editions.');
  }
  return viewer.did;
}

/**
 * The row this page edits. Resolution goes through `edition_aliases`, so a
 * retired rkey edits the book that absorbed it rather than a row that is gone.
 */
async function loadEditableRow(rkey: string): Promise<EditionRow> {
  const uri = editionUriForRkey(rkey, PUBLISHER_DID);
  const row = (await resolveEditions([uri])).get(uri);
  if (!row) error(404, 'No edition in this catalog at that rkey.');
  return row;
}

/**
 * Read one identifier line as `type:value`.
 *
 * Free-form provider pages and the `isbn:`/`urn:isbn:` scheme forms come
 * first, so a pasted URL keeps its page as the display `url`; what is left is
 * split on the *first* colon. A bare legacy resource token is mapped onto the
 * namespace it names (`isbn13` → `isbn`, `goodreads` → `goodreads.com`), which
 * keeps the stored `type` canonical.
 */
function parseIdentifierLine(raw: string): Identifier | null {
  const known = identifierFromString(raw);
  if (known) return known;

  const cut = raw.indexOf(':');
  if (cut <= 0) return null;
  const token = raw.slice(0, cut).trim().toLowerCase();
  const value = raw.slice(cut + 1).trim();
  if (!token || !value || !TYPE_PATTERN.test(token) || /\s/.test(value)) return null;

  const type = identifierTypeForResource(token);
  // `type` is what the lexicon compares, so an ISBN is always a hyphenless
  // ISBN-13 and a provider value is the provider's own key.
  if (type === 'isbn') return isbnIdentifier(value);
  if (GLOBAL_IDENTIFIER_TOKENS[type] === true) return { type, value };
  return providerIdentifier(token, value);
}

/**
 * One identifier per line, `type:value` — for example
 * `isbn:9780123456789`, `goodreads.com:12345`, or a provider page URL.
 */
function parseIdentifiers(raw: string): Identifier[] {
  const parsed: Identifier[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const identifier = parseIdentifierLine(trimmed);
    if (!identifier) {
      throw new Error(
        `Line ${index + 1}: expected "type:value" — for example ` +
          `"isbn:9780123456789" — got "${trimmed}".`,
      );
    }
    parsed.push(identifier);
  });
  if (parsed.length === 0) throw new Error('Enter at least one identifier, one per line.');
  return parsed;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  await requireLibrarian(locals.viewer, editPath(params.rkey));
  const row = await loadEditableRow(params.rkey);
  return {
    rkey: row.rkey,
    title: row.title,
    identifiers: rowIdentifiers(row.identifiers),
  };
};

export const actions: Actions = {
  backfill: async ({ request, locals, params }) => {
    await requireLibrarian(locals.viewer, editPath(params.rkey));
    const row = await loadEditableRow(params.rkey);

    const form = await request.formData();
    const cover = form.get('cover') === 'on';
    const description = form.get('description') === 'on';
    const isbn = form.get('isbn') === 'on';
    if (!cover && !description && !isbn) {
      return fail(400, { error: 'Choose at least one thing to backfill.' });
    }

    const queued: string[] = [];
    const skipped: string[] = [];

    if (cover) {
      await enqueueCoverBackfill(row.uri, row.rkey, 'manual');
      queued.push('cover');
    }
    if (description) {
      await enqueueDescriptionBackfill(row.uri, 'manual');
      queued.push('description');
    }
    if (isbn) {
      // The job would answer `already_has_isbn` anyway; checking here keeps the
      // page honest about what was actually queued.
      const [enriched] = await db
        .select({ uri: editionIsbnEnrichment.uri })
        .from(editionIsbnEnrichment)
        .where(eq(editionIsbnEnrichment.uri, row.uri))
        .limit(1);
      if (enriched) {
        skipped.push('ISBN (already enriched)');
      } else {
        await enqueueIsbnBackfill(row.uri, row.rkey, 'manual');
        queued.push('ISBN');
      }
    }

    return {
      backfill: [
        queued.length > 0 ? `Queued ${queued.join(', ')}.` : '',
        skipped.length > 0 ? `Skipped ${skipped.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },

  addIdentifiers: async ({ request, locals, params }) => {
    await requireLibrarian(locals.viewer, editPath(params.rkey));
    const row = await loadEditableRow(params.rkey);

    const form = await request.formData();
    let parsed: Identifier[];
    try {
      parsed = parseIdentifiers(String(form.get('identifiers') ?? ''));
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Those identifiers could not be read.',
      });
    }

    // Identifiers compare on `type`+`value` only, so a differing `url` is the
    // same identifier and the first-seen display url wins.
    const existing = rowIdentifiers(row.identifiers);
    const merged = uniqueIdentifiers([...existing, ...parsed]);
    // `community.lexicon.book.defs#edition` caps `identifiers` at 32 entries.
    if (merged.length > MAX_IDENTIFIERS) {
      return fail(400, {
        error: `That would leave ${merged.length} identifiers; the lexicon allows ${MAX_IDENTIFIERS}.`,
      });
    }
    const added = merged.length - existing.length;
    if (added === 0) {
      return { identifiers: 'Those identifiers are already on this edition — nothing changed.' };
    }

    // Only the catalog's own rows are ours to rewrite; a mirror is rebuilt from
    // its owner on re-ingest, so an edit here would silently disappear.
    if (row.did !== PUBLISHER_DID && !row.did.startsWith('did:web:')) {
      return fail(400, {
        error: 'This row mirrors a record owned elsewhere; edit it at its source instead.',
      });
    }

    // Identifiers are part of the record value, so the CID has to move with
    // them — otherwise clients would keep serving the old revision.
    // `defs#contributor` inlines names, so the contributor refs are resolved
    // from the same rows the response boundary reads before hashing.
    const contributors = wireContributors(
      row.contributors,
      await loadContributorRefs(contributorUrisFor(row.contributors)),
    );
    const cid = await editionRecordCid(row, { identifiers: merged, contributors });
    if (!cid) {
      return fail(400, {
        error: 'Those identifiers did not produce a valid edition record.',
      });
    }
    await db
      .update(editions)
      .set({ identifiers: merged, cid, indexedAt: new Date() })
      .where(eq(editions.uri, row.uri));

    return {
      identifiers: `Added ${added} identifier${added === 1 ? '' : 's'}; ${merged.length} total.`,
    };
  },
};
