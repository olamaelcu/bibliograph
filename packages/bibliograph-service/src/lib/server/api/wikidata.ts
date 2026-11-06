import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { wikidataBreaker } from './breakers';
import { searchProviderRequestsTotal } from '../metrics';
import type { Identifier } from '../search/types';

/**
 * Wikidata as an *enricher*: it never contributes items, it only attaches
 * structured identity links to items another source already produced.
 *
 * The join key is the item's own `wikidata` identifier: for a record that
 * already names a Q-id, the one thing left to add is the authority records
 * stored beside it. A `VALUES` lookup on the item itself is answered from
 * Wikidata's indexed triple store in about a second, where joins on external
 * keys are not.
 */
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

/** Max `VALUES` bindings per query: keeps each query inside Wikidata's ~15s budget. */
const CHUNK_SIZE = 50;
/** Wikidata asks for polite clients; serialise chunks at roughly one request per second. */
const MIN_INTERVAL_MS = 1000;
/** Matches are effectively immutable; misses are retried sooner so new items get picked up. */
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
/** `community.lexicon.book.{edition,work,contributor}.identifiers` all cap at 32. */
const MAX_IDENTIFIERS = 32;

/** `identifiers` entries to append for one matched item. */
export interface WikidataMatch {
  qid: string;
  identifiers: Identifier[];
}

interface SparqlBinding {
  value: string;
}
type SparqlBindings = Record<string, SparqlBinding | undefined>;
interface SparqlResponse {
  results?: { bindings?: SparqlBindings[] };
}

const cache = new Map<string, { match: WikidataMatch | null; expiresAt: number }>();

/** Serialises SPARQL calls and spaces their start times by `MIN_INTERVAL_MS`. */
let queue: Promise<unknown> = Promise.resolve();
let lastStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStartedAt);
    if (wait > 0) await sleep(wait);
    lastStartedAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

function qidFromEntityUri(uri: string): string | undefined {
  const m = /\/entity\/(Q\d+)$/.exec(uri);
  return m?.[1];
}

function buildQuery(qids: readonly string[]): string {
  const values = qids.map((qid) => `wd:${qid}`).join(' ');
  return `SELECT ?item (SAMPLE(?viaf) AS ?viafId) (SAMPLE(?isni) AS ?isniId) WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P214 ?viaf }
  OPTIONAL { ?item wdt:P213 ?isni }
} GROUP BY ?item`;
}

/**
 * The authorities a Q-id carries, as `identifiers` entries. The Q-id itself is
 * already on the item, so it is never repeated here; an item with neither VIAF
 * nor ISNI is a miss rather than a match with nothing to append.
 */
function toIdentifiers(viaf?: string, isni?: string): Identifier[] {
  const out: Identifier[] = [];
  if (viaf) out.push({ uri: `https://viaf.org/viaf/${viaf}`, resource: 'viaf' });
  if (isni) out.push({ uri: `https://isni.org/isni/${isni.replace(/\s+/g, '')}`, resource: 'isni' });
  return out;
}

function matchesFromBindings(bindings: readonly SparqlBindings[]): Map<string, WikidataMatch> {
  const matches = new Map<string, WikidataMatch>();
  for (const b of bindings) {
    const qid = b.item?.value ? qidFromEntityUri(b.item.value) : undefined;
    if (!qid) continue;
    const identifiers = toIdentifiers(b.viafId?.value, b.isniId?.value);
    if (identifiers.length === 0) continue;
    matches.set(qid, { qid, identifiers });
  }
  return matches;
}

async function fetchChunk(
  qids: readonly string[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<Map<string, WikidataMatch>> {
  const resolved = new Map<string, WikidataMatch>();
  if (qids.length === 0) return resolved;
  if (!wikidataBreaker.canCall()) {
    log.warn(
      { stage: 'wikidata-enricher', breaker: wikidataBreaker.getState() },
      'wikidata breaker open; skipping lookup',
    );
    return resolved;
  }

  const start = performance.now();
  try {
    const body = await throttled(() =>
      withRetry(async () => {
        const res = await fetch(SPARQL_ENDPOINT, {
          method: 'POST',
          headers: {
            'user-agent': UA,
            accept: 'application/sparql-results+json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ query: buildQuery(qids) }).toString(),
          signal: externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`wikidata ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
          err.status = res.status;
          throw err;
        }
        return (await res.json()) as SparqlResponse;
      }, log),
    );

    for (const [qid, match] of matchesFromBindings(body.results?.bindings ?? [])) resolved.set(qid, match);

    wikidataBreaker.recordSuccess();
    searchProviderRequestsTotal.inc({ provider: 'wikidata', status: 'success' });
    log.info(
      {
        stage: 'wikidata-enricher',
        requested: qids.length,
        matched: resolved.size,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      },
      'wikidata ok',
    );
    return resolved;
  } catch (err) {
    wikidataBreaker.recordFailure();
    searchProviderRequestsTotal.inc({ provider: 'wikidata', status: 'error' });
    log.error({ stage: 'wikidata-enricher', err, requested: qids.length }, 'wikidata fetch failed');
    return resolved;
  }
}

function remember(uri: string, match: WikidataMatch | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(uri, { match, expiresAt: Date.now() + (match ? HIT_TTL_MS : MISS_TTL_MS) });
}

function mergeIdentifiers(existing: readonly Identifier[], extra: readonly Identifier[]): Identifier[] {
  const seen = new Set(existing.map((id) => id.uri));
  const merged = [...existing];
  for (const id of extra) {
    if (merged.length >= MAX_IDENTIFIERS) break;
    if (seen.has(id.uri)) continue;
    seen.add(id.uri);
    merged.push(id);
  }
  return merged;
}

/**
 * Append the VIAF and ISNI authorities to any item carrying a `wikidata`
 * identifier. Items are returned untouched when nothing matches, when the
 * breaker is open, or when the endpoint fails: enrichment degrades to a no-op
 * rather than failing the search that triggered it.
 */
export async function enrichWithWikidata<T extends { identifiers: Identifier[] }>(
  items: readonly T[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<T[]> {
  if (items.length === 0) return [];

  const start = performance.now();
  const wanted = new Map<string, string>(); // identifier uri -> Q-id
  for (const item of items) {
    for (const id of item.identifiers) {
      if (id.resource !== 'wikidata') continue;
      const qid = qidFromEntityUri(id.uri);
      if (qid) wanted.set(id.uri, qid);
    }
  }

  const matches = new Map<string, WikidataMatch>();
  const pending: Array<[uri: string, qid: string]> = [];
  const now = Date.now();
  for (const [uri, qid] of wanted) {
    const cached = cache.get(uri);
    if (cached && cached.expiresAt > now) {
      if (cached.match) matches.set(uri, cached.match);
      continue;
    }
    pending.push([uri, qid]);
  }

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const resolved = await fetchChunk(chunk.map(([, qid]) => qid), log, externalSignal);
    for (const [uri, qid] of chunk) {
      const match = resolved.get(qid) ?? null;
      remember(uri, match);
      if (match) matches.set(uri, match);
    }
  }

  log.info(
    {
      stage: 'wikidata-enricher',
      items: items.length,
      requested: wanted.size,
      cached: wanted.size - pending.length,
      matched: matches.size,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    },
    'wikidata enrichment done',
  );

  if (matches.size === 0) return [...items];

  return items.map((item) => {
    const extra: Identifier[] = [];
    for (const id of item.identifiers) {
      if (id.resource !== 'wikidata') continue;
      const match = matches.get(id.uri);
      if (match) extra.push(...match.identifiers);
    }
    if (extra.length === 0) return item;
    return { ...item, identifiers: mergeIdentifiers(item.identifiers, extra) };
  });
}
