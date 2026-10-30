import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isLibrarian } from '$lib/server/labeler/labels';
import { isAdministrator } from '$lib/server/labeler/librarian';
import { PUBLISHER_DID } from '$lib/server/did';
import { db } from '$lib/server/db';
import { editions, works, publishers } from '$lib/server/db/schema';
import { searchEditions, isbnFromQuery } from '$lib/server/api/isbndb';
import { searchEditions as gbSearchEditions } from '$lib/server/api/google-books';
import { searchEditions as olSearchEditions } from '$lib/server/api/open-library';
import { randomBytes } from 'node:crypto';
import type { EditionItem } from '$lib/server/search/types';
import { createLogger } from '$lib/server/logger';
const log = createLogger('isbn-import');

function cleanIsbn(q: string): string {
  return q.replace(/[-\s]/g, '');
}

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.viewer) {
    redirect(303, `/login?next=${encodeURIComponent('/admin/import/isbn')}`);
  }
  if (!(await isLibrarian(locals.viewer.did)) && !(await isAdministrator(locals.viewer.did))) {
    error(403, 'Only librarians or administrators can access the ISBN import page.');
  }

  const q = url.searchParams.get('q') || '';
  const selectedStr = url.searchParams.get('selected');
  const selected: EditionItem | null = selectedStr ? JSON.parse(selectedStr) : null;

  let results: Record<string, EditionItem[]> = {};
  if (q.trim().length >= 5) {
    const isbn = cleanIsbn(q);
    const logStub = { info: () => {}, warn: () => {}, error: () => {} } as never;
    const [isbndbRes, gbRes, olRes] = await Promise.allSettled([
      searchEditions({ q: isbn, limit: 10 }, logStub, undefined),
      gbSearchEditions({ q: isbn, limit: 10 }, logStub, undefined),
      olSearchEditions({ q: isbn, limit: 10 }, logStub, undefined),
    ]);

    results = {
      isbndb: isbndbRes.status === 'fulfilled' ? (isbndbRes.value?.items ?? []) : [],
      'google-books': gbRes.status === 'fulfilled' ? (gbRes.value?.items ?? []) : [],
      'open-library': olRes.status === 'fulfilled' ? (olRes.value?.items ?? []) : [],
    };
    log.info({ stage: 'isbn-search', q: isbn, isbndb: results.isbndb.length, 'google-books': results['google-books'].length, 'open-library': results['open-library'].length }, 'ISBN import page search');
  }

  return {
    viewer: locals.viewer,
    isbnQuery: q,
    results,
    selected,
  };
};

export const actions: Actions = {
  search: async ({ request }) => {
    const form = await request.formData();
    const isbn = String(form.get('isbn') ?? '').trim();
    if (!isbn) return fail(400, { error: 'ISBN required' });

    const clean = cleanIsbn(isbn);
    const logStub = { info: () => {}, warn: () => {}, error: () => {} } as never;
    const [isbndbRes, gbRes, olRes] = await Promise.allSettled([
      searchEditions({ q: clean, limit: 10 }, logStub, undefined),
      gbSearchEditions({ q: clean, limit: 10 }, logStub, undefined),
      olSearchEditions({ q: clean, limit: 10 }, logStub, undefined),
    ]);

    log.info({ stage: 'isbn-search-action', isbn: clean, isbndb: isbndbRes.status, 'google-books': gbRes.status, 'open-library': olRes.status }, 'ISBN import action search');

    return {
      results: {
        isbndb: isbndbRes.status === 'fulfilled' ? (isbndbRes.value?.items ?? []) : [],
        'google-books': gbRes.status === 'fulfilled' ? (gbRes.value?.items ?? []) : [],
        'open-library': olRes.status === 'fulfilled' ? (olRes.value?.items ?? []) : [],
      }
    };
  },

  import: async ({ locals, request }) => {
    if (!locals.viewer) redirect(303, `/login?next=/admin/import/isbn`);
    if (!(await isLibrarian(locals.viewer.did)) && !(await isAdministrator(locals.viewer.did))) return fail(403, { error: 'Not a librarian or administrator.' });

    const form = await request.formData();
    const title = String(form.get('title') ?? '').trim();
    if (!title) return fail(400, { error: 'Title is required.' });

    const subtitle = String(form.get('subtitle') ?? '').trim() || null;
    const yearStr = String(form.get('year') ?? '').trim();
    const year = yearStr ? parseInt(yearStr, 10) || null : null;
    const language = String(form.get('language') ?? '').trim() || null;
    const publisherName = String(form.get('publisher') ?? '').trim() || null;
    const description = String(form.get('description') ?? '').trim() || null;
    const coverUrl = String(form.get('coverUrl') ?? '').trim() || null;

    const authorsRaw = String(form.get('authors') ?? '').trim();
    const authors = authorsRaw ? authorsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const identifiersRaw = String(form.get('identifiers') ?? '').trim();
    const identifiers = identifiersRaw ? identifiersRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const rawIsbn = String(form.get('isbn') ?? '').trim();
    const isbnClean = cleanIsbn(rawIsbn);
    const rkey = `isbn.${isbnClean || randomBytes(6).toString('base64url')}`.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 200);
    const editionUri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
    const workRkey = `work.${rkey}`;
    const workUri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${workRkey}`;

    const cid = `bafy${randomBytes(16).toString('base64url')}`;
    const contributorCids: Record<string, string> = {};
    for (const a of authors) {
      contributorCids[a] = `bafy${randomBytes(16).toString('base64url')}`;
    }

    const contributorEntries = authors.map(a => ({
      subject: { uri: `at://${PUBLISHER_DID}/community.lexicon.book.contributor/author-${cleanIsbn(a)}`, cid: contributorCids[a] ?? 'bafyseed', },
      role: 'author' as const,
    }));

    try {
      if (publisherName) {
        const pubRkey = `pub-${rkey}`;
        await db.insert(publishers).values({
          uri: `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${pubRkey}`,
          cid: `bafy${randomBytes(16).toString('base64url')}`,
          did: PUBLISHER_DID,
          rkey: pubRkey,
          name: publisherName,
          createdAt: new Date(),
          indexedAt: new Date(),
        }).onConflictDoNothing();
      }

      await db.insert(works).values({
        uri: workUri,
        cid,
        did: PUBLISHER_DID,
        rkey: workRkey,
        title,
        subtitle: subtitle ?? null,
        originalLanguage: language,
        firstPublishedYear: year,
        subjects: [],
        contributors: contributorEntries,
        identifiers: identifiers.map(i => ({ uri: i, resource: 'isbn' as const })),
        description: description ?? null,
        createdAt: new Date(),
        indexedAt: new Date(),
      });

      await db.insert(editions).values({
        uri: editionUri,
        cid,
        did: PUBLISHER_DID,
        rkey,
        title,
        subtitle: subtitle ?? null,
        workUri,
        workCid: cid,
        workLinkSource: 'manual' as const,
        publisherUri: publisherName ? `at://${PUBLISHER_DID}/community.lexicon.book.publisher/pub-${rkey}` : null,
        publisherCid: publisherName ? `bafyseed` : null,
        place: null,
        publishedYear: year,
        language,
        contributors: contributorEntries,
        identifiers: identifiers.map(i => ({ uri: i, resource: 'isbn' as const })),
        description: description ?? null,
        coverImageUrl: coverUrl,
        createdAt: new Date(),
        indexedAt: new Date(),
      });

      return { ok: true, editionUri, rkey, editionUrl: `/editions/${rkey}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(500, { error: `Import failed: ${message}` });
    }
  },


  coverSearch: async ({ locals, request }) => {
    if (!locals.viewer) redirect(303, `/login?next=/admin/import/isbn`);
    if (!(await isLibrarian(locals.viewer.did)) && !(await isAdministrator(locals.viewer.did))) return fail(403, { error: 'Not a librarian or administrator.' });

    const form = await request.formData();
    const olId = String(form.get('olId') ?? '').trim();
    if (!olId) return fail(400, { error: 'OpenLibrary identifier required.' });

    log.info({ stage: 'isbn-cover-search', olId }, 'ISBN import cover search');

    try {
      const coverUrl = `https://covers.openlibrary.org/b/id/${olId}-L.jpg`;
      return { ok: true, coverUrl };
    } catch (err) {
      return fail(500, { error: String(err) });
    }
  },
};
