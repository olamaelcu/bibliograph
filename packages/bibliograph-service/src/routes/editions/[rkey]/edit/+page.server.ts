import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { editions, editionIsbnEnrichment, type EditionRow } from '$lib/server/db/schema';
import { editionRecordCid } from '$lib/server/edition-record';
import { resolveEditions } from '$lib/server/edition-lookup';
import { editionUriForRkey } from '$lib/server/edition-work-votes';
import { PUBLISHER_DID } from '$lib/server/did';
import { isLibrarian } from '$lib/server/labeler/labels';
import {
  enqueueCoverBackfill,
  enqueueDescriptionBackfill,
  enqueueIsbnBackfill,
} from '$lib/server/jobs/enqueue';
import type { Actions, PageServerLoad } from './$types';

/** `community.lexicon.book.edition` caps `identifiers` at 32 entries. */
const MAX_IDENTIFIERS = 32;

/** Resources are slugs (`isbn13`, `wikidata`, `googlebooks-canonical`). */
const RESOURCE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type EditionIdentifier = EditionRow['identifiers'][number];

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
 * One identifier per line, `uri:resource`. Splitting on the *last* colon keeps
 * uri schemes intact: `isbn:9780123456789:isbn13` → uri `isbn:9780123456789`,
 * resource `isbn13`, and `https://example.org/x:custom` works the same way.
 */
function parseIdentifiers(raw: string): EditionIdentifier[] {
  const parsed: EditionIdentifier[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cut = trimmed.lastIndexOf(':');
    const uri = cut > 0 ? trimmed.slice(0, cut).trim() : '';
    const resource = cut > 0 ? trimmed.slice(cut + 1).trim() : '';
    if (!uri || !resource || /\s/.test(uri) || !RESOURCE_PATTERN.test(resource)) {
      throw new Error(
        `Line ${index + 1}: expected "uri:resource" — for example ` +
          `"isbn:9780123456789:isbn13" — got "${trimmed}".`,
      );
    }
    parsed.push({ uri, resource });
  });
  if (parsed.length === 0) throw new Error('Enter at least one identifier, one per line.');
  return parsed;
}

/**
 * Union in the order given, deduped on `uri|resource` — the same key
 * `computeMergedEdition` uses, so one ISBN can keep several resources.
 */
function mergeIdentifiers(
  existing: readonly EditionIdentifier[],
  incoming: readonly EditionIdentifier[],
): EditionIdentifier[] {
  const seen = new Set<string>();
  const merged: EditionIdentifier[] = [];
  for (const identifier of [...existing, ...incoming]) {
    const key = `${identifier.uri}|${identifier.resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ uri: identifier.uri, resource: identifier.resource });
  }
  return merged;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  await requireLibrarian(locals.viewer, editPath(params.rkey));
  const row = await loadEditableRow(params.rkey);
  return {
    rkey: row.rkey,
    title: row.title,
    identifiers: row.identifiers,
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
      await enqueueCoverBackfill(row.uri, row.rkey);
      queued.push('cover');
    }
    if (description) {
      await enqueueDescriptionBackfill(row.uri);
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
        await enqueueIsbnBackfill(row.uri, row.rkey);
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
    let parsed: EditionIdentifier[];
    try {
      parsed = parseIdentifiers(String(form.get('identifiers') ?? ''));
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Those identifiers could not be read.',
      });
    }

    const merged = mergeIdentifiers(row.identifiers, parsed);
    if (merged.length > MAX_IDENTIFIERS) {
      return fail(400, {
        error: `That would leave ${merged.length} identifiers; the lexicon allows ${MAX_IDENTIFIERS}.`,
      });
    }
    const added = merged.length - row.identifiers.length;
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
    const cid = await editionRecordCid(row, { identifiers: merged });
    await db
      .update(editions)
      .set({ identifiers: merged, cid, indexedAt: new Date() })
      .where(eq(editions.uri, row.uri));

    return {
      identifiers: `Added ${added} identifier${added === 1 ? '' : 's'}; ${merged.length} total.`,
    };
  },
};
