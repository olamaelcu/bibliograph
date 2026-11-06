import type { Logger } from 'pino';
import { eq, sql } from 'drizzle-orm';
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

async function lookupByName(
  name: string,
  source: ContributorSource,
): Promise<{ uri: string; cid: string } | null> {
  // Match by slug-derived rkey: the slug function is deterministic on
  // trimmed/lowercase input, so this hits the same row we'd stub-create.
  const rkey = rkeyFor(name, source);
  const uri = uriFor(rkey);
  const [row] = await db
    .select({ uri: contributors.uri, cid: contributors.cid })
    .from(contributors)
    .where(eq(contributors.uri, uri))
    .limit(1);
  if (row) return row;
  // Fall back to case-insensitive name match across sources so a Google
  // Books author and the same-named ISBNdb author resolve to the same row
  // when a real-OL equivalent already exists.
  const [nameRow] = await db
    .select({ uri: contributors.uri, cid: contributors.cid })
    .from(contributors)
    .where(sql`lower(${contributors.name}) = lower(${name})`)
    .limit(1);
  return nameRow ?? null;
}

async function stubContributor(
  name: string,
  source: ContributorSource,
  log: Logger,
): Promise<{ uri: string; cid: string }> {
  const rkey = rkeyFor(name, source);
  const uri = uriFor(rkey);
  const identifier = identifierFor(name, source);
  // Second-precision createdAt so two concurrent stubs for the same name
  // hash to the same cid and don't fight each other on disk.
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

  // cidForLex is computed over the lexicon-shaped value so the persisted
  // strongRef matches what ingestContributorBatch will store on disk.
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

  // Synchronous upsert so the next resolveContributorsByName call for the
  // same name hits the DB row instead of stubbing a fresh one. Fire-and-
  // forget queue ingestion handles the PDS write + indexedAt refresh.
  try {
    await db
      .insert(contributors)
      .values({
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
      })
      .onConflictDoUpdate({
        target: contributors.uri,
        set: { cid, name, identifiers: [identifier], indexedAt: new Date() },
      });
  } catch (err) {
    log.warn(
      { stage: 'resolve-name-contributor', uri, err: String(err) },
      'stub contributor upsert failed; continuing with computed cid',
    );
  }

  return { uri, cid };
}

/**
 * Resolve a list of plain-text author names (from Google Books, ISBNdb,
 * Goodreads, OpenLibrary search or the Bookhive catalog — none of which exposes
 * stable author IDs) into `ContributionEntry` strongRefs that point at
 * `community.lexicon.book.contributor` records in biblio.
 *
 * Each name is looked up by deterministic slug-derived rkey, then by
 * case-insensitive `name` match across sources. On miss a stub contributor
 * row is computed (cid derived via `cidForLex`) and upserted synchronously; its
 * uri+cid is returned. The row is what serving and matching read — the current
 * ingest path persists records in Postgres, and no queue task publishes
 * contributors (the OpenLibrary-fed ingest was removed in 0.4.0).
 *
 * The function never throws: malformed/empty inputs are skipped with a warn
 * log so the surrounding edition/work build can still succeed.
 */
export async function resolveContributorsByName(
  names: readonly string[],
  source: ContributorSource,
  log: Logger,
): Promise<ContributionEntry[]> {
  const entries: ContributionEntry[] = [];
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    try {
      let resolved = await lookupByName(name, source);
      if (!resolved) {
        resolved = await stubContributor(name, source, log);
      }
      entries.push({ subject: resolved, role: 'author' });
    } catch (err) {
      log.warn(
        { stage: 'resolve-name-contributor', name, err: String(err) },
        'skip malformed contributor name',
      );
    }
  }
  return entries;
}
