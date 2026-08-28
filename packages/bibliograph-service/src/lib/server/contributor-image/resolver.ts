import type { Logger } from 'pino';
import {
  commonsBreaker,
  openLibraryBreaker,
  wikidataBreaker,
} from '../api/breakers';
import { fetchJson } from '../api/open-library';
import { withRetry } from '../api/retry';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { olidFromContributorRkey } from '../ol/keys';

/**
 * Resolve a contributor image into its url + license/artist metadata.
 *
 * Two source families:
 *   1. `ol.A*` (OpenLibrary). The OL author doc carries `photos[]` and
 *      `remote_ids.wikidata` (QID). No license metadata is available from
 *      OL, so we set `attributionRequired: false` and `source: 'openlibrary'`.
 *   2. `gb.a-*` (Google Books). GB has no author-photo API. We fall back
 *      to Wikidata: search by exact name, gate on `P31:Q5` (instance of
 *      human) AND `P106` ∩ AUTHOR_OCCUPATIONS (writer/novelist/poet/etc.),
 *      then read `P18` (image) and pull Commons extmetadata for the
 *      license/artist/attribution fields.
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

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

export interface ResolvedContributorImage {
  url: string;
  source: 'openlibrary' | 'wikidata';
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

const s = (signal?: AbortSignal) => signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

function isOpenLibraryRkey(rkey: string): boolean {
  return rkey.startsWith('ol.');
}

export async function resolveContributorImage(
  opts: ResolveOptions,
): Promise<ResolvedContributorImage | undefined> {
  if (isOpenLibraryRkey(opts.rkey)) {
    return resolveOpenLibraryImage(opts);
  }
  return resolveWikidataImage(opts);
}

async function resolveOpenLibraryImage(
  opts: ResolveOptions,
): Promise<ResolvedContributorImage | undefined> {
  let olid: string;
  try {
    olid = olidFromContributorRkey(opts.rkey);
  } catch {
    return undefined;
  }
  if (!openLibraryBreaker.canCall()) {
    opts.log.warn(
      { breaker: openLibraryBreaker.getState(), rkey: opts.rkey },
      'openlibrary breaker open; skipping contributor image lookup',
    );
    return undefined;
  }
  const url = `https://openlibrary.org/authors/${olid}.json`;
  interface OlAuthorWithPhotos {
    photos?: number[];
    remote_ids?: { wikid?: string };
  };
  const raw = await fetchJson<OlAuthorWithPhotos>(url, opts.log, s(opts.signal));
  if (!raw) {
    openLibraryBreaker.recordFailure();
    return undefined;
  }
  openLibraryBreaker.recordSuccess();
  const photoId = raw.photos?.find((p: number) => typeof p === 'number' && p > 0);
  if (photoId === undefined) return undefined;

  // Construct the candidate url and validate it returns a real image
  // (200 = photo present, 302 = photo id was deleted/missing).
  const candidate = `https://covers.openlibrary.org/a/id/${photoId}-L.jpg`;
  if (!(await validateOlPhotoUrl(candidate))) return undefined;

  return {
    url: candidate,
    source: 'openlibrary',
    attributionRequired: false,
  };
}

async function validateOlPhotoUrl(candidateUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${candidateUrl}?default=false`, {
      method: 'HEAD',
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
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
    log.warn({ breaker: wikidataBreaker.getState() }, 'wikidata breaker open; skipping contributor image lookup');
    return undefined;
  }
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=5&format=json`;
  type SearchResponse = { search?: WikidataSearchHit[] };
  const raw = await fetchJson<SearchResponse>(url, log, s(signal));
  if (!raw) {
    wikidataBreaker.recordFailure();
    return undefined;
  }
  wikidataBreaker.recordSuccess();
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
    log.warn({ breaker: wikidataBreaker.getState(), qid }, 'wikidata breaker open; skipping P18 lookup');
    return undefined;
  }
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const raw = await fetchJson<WikidataEntity>(url, log, s(signal));
  if (!raw) {
    wikidataBreaker.recordFailure();
    return undefined;
  }
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

  wikidataBreaker.recordSuccess();
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
    log.warn({ breaker: commonsBreaker.getState(), filename }, 'commons breaker open; skipping extmetadata');
    return undefined;
  }
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent(`File:${filename}`)}&prop=imageinfo&iiprop=extmetadata&format=json`;
  type QueryResponse = { query?: { pages?: Record<string, { imageinfo?: Array<{ extmetadata?: CommonsExtMetadata }> }> } };
  const raw = await withRetry<QueryResponse | null>(
    () => fetchJson<QueryResponse>(url, log, s(signal)),
    log,
  );
  if (!raw) {
    commonsBreaker.recordFailure();
    return undefined;
  }
  commonsBreaker.recordSuccess();
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