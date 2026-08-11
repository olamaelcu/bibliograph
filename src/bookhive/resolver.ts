import { promises as dns } from 'node:dns';

export interface BookhiveResolverDeps {
  dnsTxtLookup?: (hostname: string) => Promise<string[]>;
  fetchDidDoc?: (did: string) => Promise<{ pds: string }>;
  fetchText?: (url: string) => Promise<string>;
}

export interface BookhiveResolverOptions {
  cacheTtlMs?: number;
}

export interface ResolvedCatalog {
  catalogDid: string;
  pdsUrl: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const TXT_HOST = '_lexicon.bookhive.buzz';

async function defaultDnsTxt(hostname: string): Promise<string[]> {
  const records = await dns.resolveTxt(hostname);
  return records.map((chunks) => chunks.join(''));
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'application/did+ld+json,application/json' },
  });
  if (!res.ok) {
    throw new Error(`fetchDidDoc: ${url} returned ${res.status}`);
  }
  return res.text();
}

interface DidDocumentService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

interface DidDocument {
  service?: DidDocumentService[];
}

async function defaultFetchDidDoc(did: string): Promise<{ pds: string }> {
  const fetchText = defaultFetchText;
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}/data`;
  } else if (did.startsWith('did:web:')) {
    const webPart = did.slice('did:web:'.length);
    url = `https://${webPart.replace(/:/g, '/')}/.well-known/did.json`;
  } else {
    throw new Error(`fetchDidDoc: unsupported DID method: ${did}`);
  }
  const body = await fetchText(url);
  const doc = JSON.parse(body) as DidDocument;
  const pdsService = doc.service?.find((s) => s.id.endsWith('#atproto_pds'));
  if (!pdsService) {
    throw new Error(`fetchDidDoc: no #atproto_pds service in DID document for ${did}`);
  }
  return { pds: pdsService.serviceEndpoint };
}

export interface BookhiveResolverApi {
  resolveCatalog: () => Promise<ResolvedCatalog>;
  /** Resolve an arbitrary user DID to its PDS service URL (did:plc via plc.directory, did:web via well-known). */
  resolvePds: (did: string) => Promise<string>;
}

export function createBookhiveResolver(
  deps: BookhiveResolverDeps = {},
  opts: BookhiveResolverOptions = {},
): BookhiveResolverApi {
  const dnsTxtLookup = deps.dnsTxtLookup ?? defaultDnsTxt;
  const fetchDidDoc = deps.fetchDidDoc ?? defaultFetchDidDoc;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  let cache: { value: ResolvedCatalog; expires: number } | null = null;
  const pdsCache = new Map<string, { pds: string; expires: number }>();

  async function resolveCatalog(): Promise<ResolvedCatalog> {
    if (cache && cache.expires > Date.now()) {
      return cache.value;
    }

    const fixedDid = process.env.BOOKHIVE_CATALOG_DID;
    const fixedPds = process.env.BOOKHIVE_PDS_URL;
    let catalogDid: string;
    let pdsUrl: string;

    if (fixedDid) {
      catalogDid = fixedDid;
    } else {
      let records: string[];
      try {
        records = await dnsTxtLookup(TXT_HOST);
      } catch (err) {
        throw new Error(
          `bookhive: DNS TXT lookup for ${TXT_HOST} failed; bookhive.buzz did not resolve (${(err as Error).message})`,
        );
      }
      const didEntry = records.find((r) => r.startsWith('did:') || /^did=|^did[=:]/i.test(r));
      if (!didEntry) {
        throw new Error(`bookhive: no did: prefix found in ${TXT_HOST} TXT record`);
      }
      // strip common DNS prefixes like "did=" before storing the actual DID
      const stripped = didEntry.replace(/^did[=:]/i, '').trim();
      catalogDid = stripped.startsWith('did:') ? stripped : didEntry;
    }

    if (fixedPds) {
      pdsUrl = fixedPds;
    } else {
      const fetched = await fetchDidDoc(catalogDid);
      pdsUrl = fetched.pds;
    }

    cache = { value: { catalogDid, pdsUrl }, expires: Date.now() + ttlMs };
    return cache.value;
  }

  async function resolvePds(did: string): Promise<string> {
    if (did === process.env.BOOKHIVE_CATALOG_DID && process.env.BOOKHIVE_PDS_URL) {
      return process.env.BOOKHIVE_PDS_URL;
    }
    const cached = pdsCache.get(did);
    if (cached && cached.expires > Date.now()) {
      return cached.pds;
    }
    const { pds } = await fetchDidDoc(did);
    pdsCache.set(did, { pds, expires: Date.now() + ttlMs });
    return pds;
  }

  return { resolveCatalog, resolvePds };
}
