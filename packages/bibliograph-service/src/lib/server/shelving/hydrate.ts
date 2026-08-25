import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { editions, records } from '../db/schema';
import type { RecordRow } from '../db/schema';
import { pdsClient } from '../pds/resolve';
import { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';
import { createLogger } from '../logger';

const log = createLogger('web');

type Did = `did:${string}:${string}`;

export async function hydrateShelvesByUri(
  uris: string[],
): Promise<Map<string, NetOlamaelcuLivtetBiblioDefs.ShelfView>> {
  if (uris.length === 0) return new Map();
  const rows = await db.select().from(records).where(inArray(records.uri, uris));
  const map = new Map<string, NetOlamaelcuLivtetBiblioDefs.ShelfView>();
  for (const r of rows) {
    const v = r.value as { name?: string };
    map.set(r.uri, {
      uri: r.uri as never,
      name: v.name ?? '',
      $type: 'net.olamaelcu.livtet.biblio.defs#shelfView',
    });
  }
  return map;
}

export async function hydrateBookByUri(
  uri: string,
): Promise<NetOlamaelcuLivtetBiblioDefs.BookView | null> {
  const [row] = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
  if (!row) return null;
  return makeBookView(row);
}

export async function hydrateBooksByUri(
  uris: string[],
): Promise<Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>> {
  if (uris.length === 0) return new Map();
  const rows = await db.select().from(editions).where(inArray(editions.uri, uris));
  const map = new Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>();
  for (const row of rows) map.set(row.uri, makeBookView(row));
  return map;
}

function makeBookView(row: typeof editions.$inferSelect): NetOlamaelcuLivtetBiblioDefs.BookView {
  return {
    uri: row.uri as never,
    title: row.title,
    coverUrl: (row.coverImageUrl ?? undefined) as never,
    publishDate: row.publishedYear ? `${row.publishedYear}` : undefined,
    contributors: (row.contributors ?? []).map((c) => ({
      bookUri: row.uri as never,
      contributor: {
        name: '',
        uri: c.subject.uri as never,
        $type: 'net.olamaelcu.livtet.biblio.defs#contributorView' as const,
      },
      role: c.role as never,
      $type: 'net.olamaelcu.livtet.biblio.defs#bookContributorView' as const,
    })),
    $type: 'net.olamaelcu.livtet.biblio.defs#bookView',
  };
}

export function buildBookShelfView(
  row: RecordRow,
  shelfView: NetOlamaelcuLivtetBiblioDefs.ShelfView,
  bookView: NetOlamaelcuLivtetBiblioDefs.BookView,
): NetOlamaelcuLivtetBiblioDefs.BookShelfView {
  const v = row.value as { metadata?: Record<string, unknown>; createdAt?: string; updatedAt?: string };
  return {
    uri: row.uri as never,
    shelf: shelfView,
    book: bookView,
    metadata: (v.metadata ?? {}) as NetOlamaelcuLivtetBiblioDefs.BookShelfMetadata,
    did: row.did as Did,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    $type: 'net.olamaelcu.livtet.biblio.defs#bookShelfView',
  };
}

export async function fetchBookShelvingRecord(
  uri: string,
  did: string,
  signal: AbortSignal,
): Promise<RecordRow | null> {
  const [cached] = await db.select().from(records).where(eq(records.uri, uri)).limit(1);
  if (cached) return cached;
  try {
    const { client } = await pdsClient(did, { signal });
    const raw = await client.get('com.atproto.repo.getRecord', {
      params: {
        repo: did as Did,
        collection: 'net.olamaelcu.livtet.biblio.bookShelving',
        rkey: uri.split('/').pop()!,
      },
      signal,
    });
    if (!raw || typeof raw !== 'object') return null;
    const wrapper = raw as { ok?: boolean; data?: { uri?: string; cid?: string; value?: Record<string, unknown> } };
    const r = (wrapper.ok === true && wrapper.data ? wrapper.data : raw) as { uri?: string; cid?: string; value?: Record<string, unknown> };
    if (typeof r.uri !== 'string' || !r.value) return null;
    return {
      uri: r.uri,
      cid: r.cid ?? 'bafyplaceholder',
      did,
      rkey: r.uri.split('/').pop() ?? '',
      collection: 'net.olamaelcu.livtet.biblio.bookShelving',
      value: r.value as never,
      createdAt: new Date(),
      indexedAt: new Date(),
    };
  } catch (err) {
    log.error({ stage: 'shelving.fetchBookShelvingRecord', uri, did, err: err instanceof Error ? err.message : String(err) }, 'PDS read failed');
    return null;
  }
}
