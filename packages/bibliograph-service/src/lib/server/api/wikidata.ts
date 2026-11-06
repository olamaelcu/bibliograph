import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { wikidataBreaker } from './breakers';
import { searchProviderRequestsTotal } from '../metrics';
import { identifierKey, PROVIDER_IDENTIFIER_DOMAINS, providerIdentifier, type Identifier } from '../identifiers';

/**
 * Wikidata as an *enricher*: it never contributes items, it only attaches
 * structured identity links to items another source already produced.
 *
 * The join key is the item's own `wikidata` identifier, i.e. the Q-id the
 * record already carries — one lookup per distinct Q-id, answered from
 * Wikidata's indexed triple store in ~1s. Items without a Q-id are not asked
 * about at all: there is nothing to join on.
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

/** `identifier.type` namespace this enricher joins on. */
const WIKIDATA_TYPE = PROVIDER_IDENTIFIER_DOMAINS.wikidata ?? 'wikidata.org';

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

interface Candidate {
  qid: string;
  viaf?: string;
  isni?: string;
}

/** Keyed by bare Q-id: the same item reached through two identifier shapes is one lookup. */
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

/** Bare `Q…` id from a Wikidata entity URI (`…/entity/Q42`). */
function qidFromEntityUri(uri: string): string | undefined {
  return /\/entity\/(Q\d+)$/i.exec(uri)?.[1]?.toUpperCase();
}

/**
 * Bare `Q…` id from a `wikidata` identifier. The value is the canonical form;
 * `url` is only the display page, so it is the fallback for identifiers written
 * before the value carried the Q-id on its own.
 */
function qidFromIdentifier(identifier: Identifier): string | undefined {
  const bare = /^(Q\d+)$/i.exec(identifier.value.trim())?.[1];
  if (bare) return bare.toUpperCase();
  return identifier.url ? qidFromEntityUri(identifier.url) : undefined;
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
 * One row per requested Q-id, carrying whatever authority ids Wikidata holds.
 * `VALUES` binds every requested Q-id whether or not Wikidata has the item, so
 * a row by itself is not a match; the links it brings are what gets appended.
 */
function parseCandidates(bindings: readonly SparqlBindings[]): Map<string, Candidate> {
  const found = new Map<string, Candidate>();
  for (const b of bindings) {
    const qid = b.item?.value ? qidFromEntityUri(b.item.value) : undefined;
    if (!qid) continue;
    found.set(qid, { qid, viaf: b.viafId?.value, isni: b.isniId?.value });
  }
  return found;
}

function toIdentifiers(c: Candidate): Identifier[] {
  const out: Identifier[] = [providerIdentifier('wikidata', `https://www.wikidata.org/entity/${c.qid}`)];
  if (c.viaf) out.push(providerIdentifier('viaf', `https://viaf.org/viaf/${c.viaf}`));
  if (c.isni) out.push(providerIdentifier('isni', `https://isni.org/isni/${c.isni.replace(/\s+/g, '')}`));
  return out;
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

    const found = parseCandidates(body.results?.bindings ?? []);
    for (const [qid, candidate] of found) resolved.set(qid, { qid, identifiers: toIdentifiers(candidate) });

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

function remember(qid: string, match: WikidataMatch | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(qid, { match, expiresAt: Date.now() + (match ? HIT_TTL_MS : MISS_TTL_MS) });
}

function mergeIdentifiers(existing: readonly Identifier[], extra: readonly Identifier[]): Identifier[] {
  const seen = new Set(existing.map((id) => identifierKey(id)));
  const merged = [...existing];
  for (const id of extra) {
    if (merged.length >= MAX_IDENTIFIERS) break;
    const key = identifierKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(id);
  }
  return merged;
}

/**
 * Append Wikidata's authority links (VIAF, ISNI) to any item carrying a
 * `wikidata` identifier. Items are returned untouched when nothing matches,
 * when the breaker is open, or when the endpoint fails: enrichment degrades to
 * a no-op rather than failing the search that triggered it.
 */
export async function enrichWithWikidata<T extends { identifiers: Identifier[] }>(
  items: readonly T[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<T[]> {
  if (items.length === 0) return [];

  const start = performance.now();
  const wanted = new Set<string>();
  for (const item of items) {
    for (const id of item.identifiers) {
      if (id.type !== WIKIDATA_TYPE) continue;
      const qid = qidFromIdentifier(id);
      if (qid) wanted.add(qid);
    }
  }
  if (wanted.size === 0) return [...items];

  const matches = new Map<string, WikidataMatch>();
  const pending: string[] = [];
  const now = Date.now();
  for (const qid of wanted) {
    const cached = cache.get(qid);
    if (cached && cached.expiresAt > now) {
      if (cached.match) matches.set(qid, cached.match);
      continue;
    }
    pending.push(qid);
  }

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const resolved = await fetchChunk(chunk, log, externalSignal);
    for (const qid of chunk) {
      const match = resolved.get(qid) ?? null;
      remember(qid, match);
      if (match) matches.set(qid, match);
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
      if (id.type !== WIKIDATA_TYPE) continue;
      const qid = qidFromIdentifier(id);
      const match = qid ? matches.get(qid) : undefined;
      if (match) extra.push(...match.identifiers);
    }
    if (extra.length === 0) return item;
    return { ...item, identifiers: mergeIdentifiers(item.identifiers, extra) };
  });
}
