#!/usr/bin/env tsx
// Seed the publishers table from Wikidata + OpenLibrary.
//
// Strategy:
//   1. SPARQL against query.wikidata.org for entities that
//        (a) are publishing houses (Q175191 or subclass)
//        (b) link to their OpenLibrary publisher page via P856 (official website)
//      Filter to rows whose homepage URL contains "openlibrary.org/publishers/".
//   2. For each hit, parse the OL slug from that URL and HEAD/PATCH-fetch
//      https://openlibrary.org/publishers/{slug}.json.
//   3. On 200, pull `name` and harvest founding/closing dates if present.
//   4. Upsert into the `publishers` table under PUBLISHER_DID with
//      rkey = ol-publisher-{slug}, CID computed via @atproto/lex-cbor.
//
// Usage:
//   pnpm seed:publishers [--limit=200] [--dry-run]
//
// Env:
//   DATABASE_URL              (required)
//   LEX_PUBLISHER_DID         (default: did:web:biblio.livtet.olamaelcu.net)
//   WD_USER_AGENT             (recommended — Wikidata asks for one)

import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { db } from '../src/lib/server/db';
import { publishers } from '../src/lib/server/db/schema';
import { PUBLISHER_DID } from '../src/lib/server/did';
import { cidForLex } from '@atproto/lex-cbor';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', transport: undefined });

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT = process.env.WD_USER_AGENT ?? 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

interface Args {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let limit = 200;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else if (arg === '--dry-run') dryRun = true;
  }
  return { limit, dryRun };
}

interface SparqlRow {
  item: { value: string };
  itemLabel: { value: string };
  homepage: { value: string };
}

interface SparqlResponse {
  results: { bindings: SparqlRow[] };
}

async function fetchWikidata(limit: number, offset: number): Promise<SparqlRow[]> {
  const query = `
SELECT ?item ?itemLabel ?homepage WHERE {
  ?item wdt:P31 wd:Q175191 .
  ?item wdt:P856 ?homepage .
  FILTER(CONTAINS(LCASE(STR(?homepage)), "openlibrary.org/publishers/"))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${limit} OFFSET ${offset}
`.trim();
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wikidata SPARQL ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as SparqlResponse;
  return data.results.bindings;
}

function olSlugFromHomepage(homepage: string): string | null {
  // homepage is e.g. "https://openlibrary.org/publishers/Penguin"
  const m = /openlibrary\.org\/publishers\/([^/?#]+)/i.exec(homepage);
  return m ? decodeURIComponent(m[1]!) : null;
}

interface OlPublisherPage {
  name?: string;
  locations?: unknown;
}

async function fetchOlPublisher(slug: string): Promise<OlPublisherPage | null> {
  const url = `https://openlibrary.org/publishers/${encodeURIComponent(slug)}.json`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (res.status === 404) return null;
    if (!res.ok) {
      log.warn({ stage: 'seed-publishers', slug, status: res.status }, 'ol non-2xx');
      return null;
    }
    return (await res.json()) as OlPublisherPage;
  } catch (err) {
    log.warn({ stage: 'seed-publishers', slug, err: String(err) }, 'ol fetch failed');
    return null;
  }
}

async function upsertPublisher(record: {
  uri: string;
  name: string;
  identifiers: Array<{ uri: string; resource: string }>;
  foundingDate?: number;
  closingDate?: number;
}): Promise<void> {
  const value = {
    $type: 'community.lexicon.book.publisher',
    name: record.name,
    foundingDate: record.foundingDate,
    closingDate: record.closingDate,
    identifiers: record.identifiers,
    createdAt: new Date().toISOString(),
  };
  const cid = (await cidForLex(value as never)).toString();
  const [existing] = await db.select().from(publishers).where(eq(publishers.uri, record.uri)).limit(1);
  if (existing) {
    await db
      .update(publishers)
      .set({
        cid,
        name: record.name,
        foundingDate: record.foundingDate ?? null,
        closingDate: record.closingDate ?? null,
        identifiers: record.identifiers,
      })
      .where(eq(publishers.uri, record.uri));
    return;
  }
  const rkey = record.uri.split('/').pop()!;
  await db.insert(publishers).values({
    uri: record.uri,
    cid,
    did: PUBLISHER_DID,
    rkey,
    name: record.name,
    foundingDate: record.foundingDate ?? null,
    closingDate: record.closingDate ?? null,
    identifiers: record.identifiers,
    createdAt: new Date(value.createdAt),
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  const { limit, dryRun } = parseArgs(process.argv);
  const offsetStart = 0;
  const offsetStep = 50;
  let offset = offsetStart;
  let inserted = 0;
  let skipped = 0;
  let total = 0;

  while (offset < limit) {
    const page = await fetchWikidata(Math.min(offsetStep, limit - offset), offset);
    if (page.length === 0) break;
    for (const row of page) {
      if (total >= limit) break;
      total++;
      const slug = olSlugFromHomepage(row.homepage.value);
      if (!slug) {
        skipped++;
        log.debug({ stage: 'seed-publishers', homepage: row.homepage.value }, 'no slug');
        continue;
      }
      const rkey = `ol-publisher-${slug}`;
      const uri = `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${rkey}`;
      const olPage = await fetchOlPublisher(slug);
      if (!olPage || !olPage.name) {
        skipped++;
        log.info({ stage: 'seed-publishers', slug }, 'no OL page');
        continue;
      }
      const record = {
        uri,
        name: olPage.name,
        identifiers: [{ uri: `https://openlibrary.org/publishers/${slug}`, resource: 'openlibrary' as const }],
      };
      if (dryRun) {
        log.info({ stage: 'seed-publishers', slug, name: record.name }, 'would insert');
        inserted++;
        continue;
      }
      try {
        await upsertPublisher(record);
        inserted++;
        log.info({ stage: 'seed-publishers', slug, name: record.name }, 'inserted');
      } catch (err) {
        skipped++;
        log.error({ stage: 'seed-publishers', slug, err: String(err) }, 'upsert failed');
      }
    }
    offset += page.length;
    if (page.length < offsetStep) break;
  }
  log.info({ stage: 'seed-publishers', total, inserted, skipped, dryRun }, 'seed complete');
}

main().catch((err) => {
  log.error({ stage: 'seed-publishers', err: String(err) }, 'fatal');
  process.exit(1);
});
