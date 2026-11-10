import type { Logger } from 'pino';
import { commonsBreaker, wikidataBreaker } from '../api/breakers';
import { UpstreamDeferred } from '../api/deferred';
import { fetchJson } from '../api/fetch-json';
import { withRetry } from '../api/retry';

/**
 * Resolve a contributor image into its url + license/artist metadata.
 *
 * Google Books has no author-photo API, so the source is Wikidata: search by
 * exact name, gate on `P31:Q5` (instance of human) AND `P106` ∩
 * AUTHOR_OCCUPATIONS (writer/novelist/poet/etc.), then read `P18` (image) and
 * pull Commons extmetadata for the license/artist/attribution fields.
 *
 * The result is intentionally `undefined` when nothing resolvable was
 * found (NOT an error). The caller records `imageCheckedAt` either way so
 * the resolver is not re-attempted for a permanently missing author.
 */

const AUTHOR_OCCUPATIONS = new Set([
  'Q36180', // writer
  'Q6625963', // novelist
  'Q49757', // poet
  'Q214917', // playwright
  'Q11774202', // essayist
  'Q1607826', // editor
  'Q333634', // translator
]);

const WIKIDATA_FETCH = { breaker: wikidataBreaker, provider: 'wikidata', stage: 'wikidata-image' };
const COMMONS_FETCH = { breaker: commonsBreaker, provider: 'commons', stage: 'commons-image' };

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

export interface ResolvedContributorImage {
  url: string;
  source: 'wikidata';
  artist?: string;
  license?: string;
  licenseUrl?: string;
  attributionRequired: boolean;
}

export interface ResolveOptions {
  rkey: string;
  name: string;
  log: Logger;
  signal?: AbortSignal;
}

/**
 * The resolver's contract. Named here so callers inject a stub without
 * referencing the implementation's inferred type.
 */
export type ContributorImageResolver = (
  opts: ResolveOptions,
) => Promise<ResolvedContributorImage | undefined>;

export async function resolveContributorImage(
  opts: ResolveOptions,
): Promise<ResolvedContributorImage | undefined> {
  return resolveWikidataImage(opts);
}

async function resolveWikidataImage(
  opts: ResolveOptions,
): Promise<ResolvedContributorImage | undefined> {
  const qid = await findAuthorQid(opts.name, opts.log, opts.signal);
  if (!qid) return undefined;

  const photoFile = await fetchPhotoFilename(qid, opts.log, opts.signal);
  if (!photoFile) return undefined;

  const extmeta = await fetchCommonsExtMetadata(photoFile, opts.log, opts.signal);
  if (!extmeta) return undefined;

  return {
    url: commonsFileUrl(photoFile),
    source: 'wikidata',
    artist: extmeta.artist,
    license: extmeta.license,
    licenseUrl: extmeta.licenseUrl,
    attributionRequired: extmeta.attributionRequired,
  };
}

interface WikidataSearchHit {
  id: string;
  label?: string;
  description?: string;
  match?: { type?: string; text?: string };
}

interface WikidataEntity {
  entities: Record<
    string,
    {
      labels?: Record<string, { value: string }>;
      claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
    }
  >;
}

interface CommonsExtMetadata {
  Artist?: { value: string };
  LicenseShortName?: { value: string };
  LicenseUrl?: { value: string };
  AttributionRequired?: { value: string };
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function findAuthorQid(
  name: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!wikidataBreaker.canCall()) {
    log.warn({ breaker: wikidataBreaker.getState() }, 'wikidata breaker open; deferring contributor image lookup');
    throw new UpstreamDeferred('wikidata', 'breaker-open');
  }
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=5&format=json`;
  type SearchResponse = { search?: WikidataSearchHit[] };
  const raw = await fetchJson<SearchResponse>(url, log, signal, WIKIDATA_FETCH);
  if (!raw) throw new UpstreamDeferred('wikidata', 'request-failed');
  const target = normalizeName(name);
  for (const hit of raw.search ?? []) {
    if (hit.label && normalizeName(hit.label) === target) {
      return hit.id;
    }
  }
  return undefined;
}

async function fetchPhotoFilename(
  qid: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!wikidataBreaker.canCall()) {
    log.warn({ breaker: wikidataBreaker.getState(), qid }, 'wikidata breaker open; deferring P18 lookup');
    throw new UpstreamDeferred('wikidata', 'breaker-open');
  }
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const raw = await fetchJson<WikidataEntity>(url, log, signal, WIKIDATA_FETCH);
  if (!raw) throw new UpstreamDeferred('wikidata', 'request-failed');
  const entity = raw.entities?.[qid];
  if (!entity) return undefined;

  // Gate 1: P31 ∋ Q5 (instance of human).
  const p31 = entity.claims?.P31 ?? [];
  const isHuman = p31.some((c: { mainsnak?: { datavalue?: { value?: unknown } } }) => {
    const id = (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id;
    return id === 'Q5';
  });
  if (!isHuman) return undefined;

  // Gate 2: P106 ∩ AUTHOR_OCCUPATIONS.
  const p106 = entity.claims?.P106 ?? [];
  const occupations = new Set(
    p106
      .map((c: { mainsnak?: { datavalue?: { value?: unknown } } }) =>
        (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const hasAuthorOccupation = [...AUTHOR_OCCUPATIONS].some((q) => occupations.has(q));
  if (!hasAuthorOccupation) return undefined;

  // P18 = image (Commons filename, e.g. "Frank Herbert 1984 (square).jpg").
  const p18 = entity.claims?.P18?.[0];
  const filename = p18?.mainsnak?.datavalue?.value as string | undefined;
  if (!filename) return undefined;
  return filename;
}

async function fetchCommonsExtMetadata(
  filename: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<{
  artist?: string;
  license?: string;
  licenseUrl?: string;
  attributionRequired: boolean;
} | undefined> {
  if (!commonsBreaker.canCall()) {
    log.warn({ breaker: commonsBreaker.getState(), filename }, 'commons breaker open; deferring extmetadata');
    throw new UpstreamDeferred('commons', 'breaker-open');
  }
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent(`File:${filename}`)}&prop=imageinfo&iiprop=extmetadata&format=json`;
  type QueryResponse = { query?: { pages?: Record<string, { imageinfo?: Array<{ extmetadata?: CommonsExtMetadata }> }> } };
  const raw = await withRetry<QueryResponse | null>(
    () => fetchJson<QueryResponse>(url, log, signal, COMMONS_FETCH),
    log,
  );
  if (!raw) throw new UpstreamDeferred('commons', 'request-failed');
  const pages = raw.query?.pages ?? {};
  for (const key of Object.keys(pages)) {
    const page = pages[key];
    if (!page) continue;
    const em = page.imageinfo?.[0]?.extmetadata;
    if (!em) continue;
    return {
      artist: em.Artist?.value || undefined,
      license: em.LicenseShortName?.value || undefined,
      licenseUrl: em.LicenseUrl?.value || undefined,
      attributionRequired: em.AttributionRequired?.value === 'true',
    };
  }
  return undefined;
}

function commonsFileUrl(filename: string): string {
  const titleParam = encodeURIComponent(`File:${filename}`);
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${titleParam}?width=400`;
}