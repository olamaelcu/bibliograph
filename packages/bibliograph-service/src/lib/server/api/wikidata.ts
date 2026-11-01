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
 * The join key is Open Library's own ID (Wikidata P648), because that is the
 * identifier every OL-sourced edition/work/contributor already carries, and it
 * is answered from Wikidata's indexed triple store in ~1s. ISBN joins (P212)
 * were measured at 20s+ and returned nothing for real OL ISBNs, so they are not
 * used — see the smoke notes in the PR body.
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

interface Candidate {
  qid: string;
  sitelinks: number;
  viaf?: string;
  isni?: string;
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

const OL_URI = /^https?:\/\/openlibrary\.org\/(?:works|books|authors)\/(OL\d+[A-Z])$/;

/** Bare Open Library ID (`OL66554W`) from an `openlibrary` identifier URI. */
export function olIdFromIdentifierUri(uri: string): string | undefined {
  return OL_URI.exec(uri)?.[1];
}

function qidFromEntityUri(uri: string): string | undefined {
  const m = /\/entity\/(Q\d+)$/.exec(uri);
  return m?.[1];
}

/** Lower Q-number = older, usually the canonical item; used only to break sitelink ties. */
function qidNumber(qid: string): number {
  return Number(qid.slice(1));
}

function buildQuery(olIds: readonly string[]): string {
  const values = olIds.map((id) => `"${id}"`).join(' ');
  return `SELECT ?item ?olid (MAX(?sitelinks) AS ?links) (SAMPLE(?viaf) AS ?viafId) (SAMPLE(?isni) AS ?isniId) WHERE {
  VALUES ?olid { ${values} }
  ?item wdt:P648 ?olid .
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  OPTIONAL { ?item wdt:P214 ?viaf }
  OPTIONAL { ?item wdt:P213 ?isni }
} GROUP BY ?item ?olid`;
}

/**
 * One OLID can be claimed by several Wikidata items (a stub duplicating a real
 * one). Pick the item with the most sitelinks — a notability proxy that
 * reliably separates the real item from an empty duplicate — then the lowest
 * Q-number so the choice is stable across runs.
 */
function rankCandidates(bindings: readonly SparqlBindings[]): Map<string, Candidate> {
  const grouped = new Map<string, Candidate[]>();
  for (const b of bindings) {
    const olid = b.olid?.value;
    const qid = b.item?.value ? qidFromEntityUri(b.item.value) : undefined;
    if (!olid || !qid) continue;
    const list = grouped.get(olid) ?? [];
    list.push({
      qid,
      sitelinks: Number(b.links?.value ?? 0) || 0,
      viaf: b.viafId?.value,
      isni: b.isniId?.value,
    });
    grouped.set(olid, list);
  }

  const best = new Map<string, Candidate>();
  for (const [olid, list] of grouped) {
    list.sort((a, b) => b.sitelinks - a.sitelinks || qidNumber(a.qid) - qidNumber(b.qid));
    const winner = list[0];
    if (winner) best.set(olid, winner);
  }
  return best;
}

function toIdentifiers(c: Candidate): Identifier[] {
  const out: Identifier[] = [{ uri: `https://www.wikidata.org/entity/${c.qid}`, resource: 'wikidata' }];
  if (c.viaf) out.push({ uri: `https://viaf.org/viaf/${c.viaf}`, resource: 'viaf' });
  if (c.isni) out.push({ uri: `https://isni.org/isni/${c.isni.replace(/\s+/g, '')}`, resource: 'isni' });
  return out;
}

async function fetchChunk(
  olIds: readonly string[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<Map<string, WikidataMatch>> {
  const resolved = new Map<string, WikidataMatch>();
  if (olIds.length === 0) return resolved;
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
          body: new URLSearchParams({ query: buildQuery(olIds) }).toString(),
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

    const best = rankCandidates(body.results?.bindings ?? []);
    for (const [olid, candidate] of best) resolved.set(olid, { qid: candidate.qid, identifiers: toIdentifiers(candidate) });

    wikidataBreaker.recordSuccess();
    searchProviderRequestsTotal.inc({ provider: 'wikidata', status: 'success' });
    log.info(
      {
        stage: 'wikidata-enricher',
        requested: olIds.length,
        matched: resolved.size,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      },
      'wikidata ok',
    );
    return resolved;
  } catch (err) {
    wikidataBreaker.recordFailure();
    searchProviderRequestsTotal.inc({ provider: 'wikidata', status: 'error' });
    log.error({ stage: 'wikidata-enricher', err, requested: olIds.length }, 'wikidata fetch failed');
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
 * Append Wikidata identity links to any item carrying `openlibrary`
 * identifiers. Items are returned untouched when nothing matches, when the
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
  const wanted = new Map<string, string>(); // identifier uri -> OLID
  for (const item of items) {
    if (item.identifiers.some((id) => id.resource === 'wikidata')) continue;
    for (const id of item.identifiers) {
      if (id.resource !== 'openlibrary') continue;
      const olid = olIdFromIdentifierUri(id.uri);
      if (olid) wanted.set(id.uri, olid);
    }
  }

  const matches = new Map<string, WikidataMatch>();
  const pending: Array<[uri: string, olid: string]> = [];
  const now = Date.now();
  for (const [uri, olid] of wanted) {
    const cached = cache.get(uri);
    if (cached && cached.expiresAt > now) {
      if (cached.match) matches.set(uri, cached.match);
      continue;
    }
    pending.push([uri, olid]);
  }

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const resolved = await fetchChunk(chunk.map(([, olid]) => olid), log, externalSignal);
    for (const [uri, olid] of chunk) {
      const match = resolved.get(olid) ?? null;
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
      if (id.resource !== 'openlibrary') continue;
      const match = matches.get(id.uri);
      if (match) extra.push(...match.identifiers);
    }
    if (extra.length === 0) return item;
    return { ...item, identifiers: mergeIdentifiers(item.identifiers, extra) };
  });
}
