import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';
import { EditionMergeError, mergeEditionsInDb } from '$lib/server/edition-merge';
import { db } from '$lib/server/db';
import { log } from '$lib/server/xrpc-router';

const EDITION_COLLECTION = 'community.lexicon.book.edition';

/** URIs are pasted one per line (or comma-separated) out of the catalog pages. */
function parseUris(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function looksLikeEditionUri(uri: string): boolean {
  return uri.startsWith('at://') && uri.includes(`/${EDITION_COLLECTION}/`);
}

/**
 * `keep` leaves the field alone, `clear` sets it to empty, `replace` uses the
 * submitted value. Mirrors `computeMergedEdition`: undefined keeps, '' clears.
 */
function pickOverride(
  form: FormData,
  field: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const mode = String(form.get(`${field}Mode`) ?? 'keep');
  if (mode === 'keep') return { ok: true, value: undefined };
  if (mode === 'clear') return { ok: true, value: '' };
  const value = String(form.get(field) ?? '').trim();
  if (value.length === 0) return { ok: false };
  return { ok: true, value };
}

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals.viewer, '/admin/editions/merge');
};

export const actions: Actions = {
  merge: async ({ request, locals }) => {
    const adminDid = await requireAdmin(locals.viewer, '/admin/editions/merge');
    const form = await request.formData();

    const primaryUri = String(form.get('primaryUri') ?? '').trim();
    if (!looksLikeEditionUri(primaryUri)) {
      return fail(400, {
        error:
          'The edition to keep must be a full at:// URI, e.g. ' +
          'at://did:web:…/community.lexicon.book.edition/ol.OL1M',
      });
    }

    const others = [...new Set(parseUris(String(form.get('otherUris') ?? '')))].filter(
      (uri) => uri !== primaryUri,
    );
    if (others.length === 0) {
      return fail(400, { error: 'Name at least one other edition to merge into the one you keep.' });
    }
    const malformed = others.filter((uri) => !looksLikeEditionUri(uri));
    if (malformed.length > 0) {
      return fail(400, { error: `Not edition URIs: ${malformed.join(', ')}` });
    }

    const cover = pickOverride(form, 'coverImageUrl');
    const description = pickOverride(form, 'description');
    if (!cover.ok) {
      return fail(400, { error: 'Enter a cover URL, or choose to keep or clear the cover.' });
    }
    if (!description.ok) {
      return fail(400, { error: 'Enter a description, or choose to keep or clear the description.' });
    }
    if (cover.value && !/^https?:\/\//.test(cover.value)) {
      return fail(400, { error: 'The cover must be an http(s) URL.' });
    }

    try {
      const result = await mergeEditionsInDb(
        db,
        [primaryUri, ...others],
        primaryUri,
        cover.value,
        description.value,
      );
      log.info(
        { adminDid, primaryUri, deleted: result.deleted },
        'edition merge applied',
      );
      return {
        merged: {
          uri: result.merged.uri,
          title: result.merged.title,
          identifiers: result.merged.identifiers,
          contributors: result.merged.contributors,
          coverImageUrl: result.merged.coverImageUrl,
          description: result.merged.description,
        },
        deleted: result.deleted,
      };
    } catch (err) {
      // A stale selection is the admin's problem to fix; anything else is ours.
      if (err instanceof EditionMergeError) return fail(400, { error: err.message });
      log.error({ err, adminDid, primaryUri }, 'edition merge failed');
      return fail(500, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
