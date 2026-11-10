import type { Logger } from 'pino';
import { eq, inArray, sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db } from '../db';
import { contributors } from '../db/schema';
import { PUBLISHER_DID } from '../did';
import type { ContributionEntry, Identifier } from '../search/types';
import { providerIdentifier } from '../identifiers';

export type ContributorSource = 'googlebooks' | 'isbndb' | 'goodreads' | 'openlibrary' | 'bookhive';

const GB_PREFIX = 'gb.a-';
const ISBNDB_PREFIX = 'isbndb.a-';
const GR_PREFIX = 'gr.a-';
const OL_PREFIX = 'ol.a-';
const BH_PREFIX = 'bh.a-';

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function rkeyFor(name: string, source: ContributorSource): string {
  const slug = slugify(name);
  if (source === 'googlebooks') return `${GB_PREFIX}${slug}`;
  if (source === 'isbndb') return `${ISBNDB_PREFIX}${slug}`;
  if (source === 'openlibrary') return `${OL_PREFIX}${slug}`;
  if (source === 'bookhive') return `${BH_PREFIX}${slug}`;
  return `${GR_PREFIX}${slug}`;
}

function uriFor(rkey: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkey}`;
}

function identifierFor(name: string, source: ContributorSource): Identifier {
  // The synthetic `{source}://contributor/{slug}` URI is the identifier's own
  // reference, not a provider page, so it only rides along as `url`; the pair
  // clients compare is the provider domain plus the slug.
  return providerIdentifier(source, `${source}://contributor/${slugify(name)}`);
}

interface ResolvedRef {
  uri: string;
  cid: string;
}

/** Bind-parameter ceiling for one `= any(...)` list; Postgres allows 65,535. */
const NAME_CHUNK = 1_000;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The row a stub contributor would persist, and the cid derived from it.
 *
 * `cidForLex` is computed over the lexicon-shaped value so the strongRef the
 * caller publishes matches what the ingest path stores for the same record.
 * `createdAt` is truncated to second precision so two concurrent stubs for one
 * name hash to the same cid instead of fighting each other on write.
 */
async function buildStub(
  name: string,
  source: ContributorSource,
): Promise<{ ref: ResolvedRef; row: typeof contributors.$inferInsert }> {
  const rkey = rkeyFor(name, source);
  const uri = uriFor(rkey);
  const identifier = identifierFor(name, source);
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const value = {
    $type: 'community.lexicon.book.contributor' as const,
    name,
    aliases: [] as string[],
    bio: undefined,
    bornYear: undefined,
    diedYear: undefined,
    linkedDid: undefined,
    identifiers: [identifier],
    createdAt,
  };
  const cid = (await cidForLex(value as unknown as LexMap)).toString();
  return {
    ref: { uri, cid },
    row: {
      uri,
      cid,
      did: PUBLISHER_DID,
      rkey,
      name,
      aliases: [],
      linkedDid: null,
      bio: null,
      bornYear: null,
      diedYear: null,
      identifiers: [identifier],
      createdAt: new Date(createdAt),
    },
  };
}

/**
 * Resolve one name on its own: the same three phases the prefetch runs for a
 * page, for the rare caller that names an author the prefetch never saw.
 */
async function resolveOne(
  name: string,
  source: ContributorSource,
  log: Logger,
): Promise<ResolvedRef> {
  const uri = uriFor(rkeyFor(name, source));
  const [byUri] = await db
    .select({ uri: contributors.uri, cid: contributors.cid })
    .from(contributors)
    .where(eq(contributors.uri, uri))
    .limit(1);
  if (byUri) return byUri;

  const [byName] = await db
    .select({ uri: contributors.uri, cid: contributors.cid })
    .from(contributors)
    .where(sql`lower(${contributors.name}) = lower(${name})`)
    .limit(1);
  if (byName) return byName;

  const stub = await buildStub(name, source);
  try {
    await db
      .insert(contributors)
      .values(stub.row)
      .onConflictDoUpdate({
        target: contributors.uri,
        set: {
          cid: stub.ref.cid,
          name,
          identifiers: stub.row.identifiers,
          indexedAt: new Date(),
        },
      });
  } catch (err) {
    log.warn(
      { stage: 'resolve-name-contributor', uri: stub.ref.uri, err: String(err) },
      'stub contributor upsert failed; continuing with computed cid',
    );
  }
  return stub.ref;
}

/**
 * Resolves names already carried by a `ContributorResolver`, each of which the
 * prefetch answered in a bound number of queries for the whole page.
 */
export interface ContributorResolver {
  resolve(names: readonly string[]): Promise<ContributionEntry[]>;
}

/**
 * Resolve a whole page of plain-text author names in one pass.
 *
 * Names arrive from Google Books, ISBNdb, Goodreads, OpenLibrary search and the
 * Bookhive catalog — none of which exposes stable author IDs — so each is looked
 * up by its deterministic slug-derived rkey, then by case-insensitive `name`
 * across sources, and stubbed (with a lexicon-derived cid) when neither hits.
 *
 * Doing this per name cost 1–3 round trips each: a 40-volume Google Books page
 * issued 40–120 of them before any enrichment ran, all against a pool of ten.
 * This function answers the same question with one query per key shape plus one
 * multi-row upsert for the stubs, and the returned resolver is then a map read.
 *
 * The prefetch never throws: malformed/empty names are skipped, and a failed
 * stub write logs and still answers with the computed cid, so the surrounding
 * edition/work build can succeed.
 */
export async function prefetchContributors(
  names: readonly string[],
  source: ContributorSource,
  log: Logger,
): Promise<ContributorResolver> {
  /** lower(name) → the name as first seen, so the stub keeps its spelling. */
  const wanted = new Map<string, string>();
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!wanted.has(key)) wanted.set(key, name);
  }

  const resolved = new Map<string, ResolvedRef>();
  if (wanted.size > 0) {
    // Pass 1: the deterministic rkey means the uri alone identifies the row.
    const uriByKey = new Map<string, string>();
    for (const [key, name] of wanted) uriByKey.set(key, uriFor(rkeyFor(name, source)));
    const uriRows = await db
      .select({ uri: contributors.uri, cid: contributors.cid })
      .from(contributors)
      .where(inArray(contributors.uri, [...uriByKey.values()]));
    const cidByUri = new Map(uriRows.map((row) => [row.uri, row.cid]));
    const pending: string[] = [];
    for (const [key, uri] of uriByKey) {
      const cid = cidByUri.get(uri);
      if (cid !== undefined) resolved.set(key, { uri, cid });
      else pending.push(key);
    }

    // Pass 2: a case-insensitive name match across sources, so a Google Books
    // author and the same-named ISBNdb author share the row that already exists.
    for (const chunk of chunked(pending, NAME_CHUNK)) {
      const nameRows: Array<{ uri: string; cid: string; name: string }> = [];
      for (const part of chunked(chunk, NAME_CHUNK)) {
        nameRows.push(
          ...(await db
            .select({ uri: contributors.uri, cid: contributors.cid, name: contributors.name })
            .from(contributors)
            .where(inArray(sql`lower(${contributors.name})`, part))),
        );
      }
      const byName = new Map(nameRows.map((row) => [row.name.toLowerCase(), row]));
      for (const key of chunk) {
        const hit = byName.get(key);
        if (hit) resolved.set(key, { uri: hit.uri, cid: hit.cid });
      }
    }

    // Pass 3: stub whatever is left, in one upsert. The rows are written
    // synchronously so the next page's prefetch reads them instead of stubbing
    // again; a failure is logged and the computed cid still answers.
    const stubs = await Promise.all(
      [...wanted].filter(([key]) => !resolved.has(key)).map(async ([key, name]) => ({ key, ...(await buildStub(name, source)) })),
    );
    for (const stub of stubs) resolved.set(stub.key, stub.ref);
    if (stubs.length > 0) {
      try {
        await db
          .insert(contributors)
          .values(stubs.map((stub) => stub.row))
          .onConflictDoUpdate({
            target: contributors.uri,
            set: {
              cid: sql`excluded.cid`,
              name: sql`excluded.name`,
              identifiers: sql`excluded.identifiers`,
              indexedAt: new Date(),
            },
          });
      } catch (err) {
        log.warn(
          { stage: 'resolve-name-contributor', count: stubs.length, err: String(err) },
          'stub contributor upsert failed; continuing with computed cids',
        );
      }
    }
  }

  return {
    async resolve(list: readonly string[]): Promise<ContributionEntry[]> {
      const entries: ContributionEntry[] = [];
      for (const raw of list) {
        const name = raw?.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        let ref = resolved.get(key);
        if (!ref) {
          // A caller passed a name the prefetch never saw. Resolve just that one
          // rather than dropping the author: a missing contributor is a wrong
          // record, and this path is rare by construction.
          try {
            ref = await resolveOne(name, source, log);
          } catch (err) {
            log.warn(
              { stage: 'resolve-name-contributor', name, err: String(err) },
              'skip malformed contributor name',
            );
            continue;
          }
        }
        entries.push({ subject: { uri: ref.uri, cid: ref.cid }, role: 'author' });
      }
      return entries;
    },
  };
}
