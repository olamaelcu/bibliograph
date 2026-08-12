import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LEXICONS_DIR = resolve('lexicons');
const DEFAULT_NS_PREFIX = 'community.lexicon.book';

export const LEX_TYPES = ['query', 'procedure', 'record', 'subscription', 'token'] as const;
export type LexType = (typeof LEX_TYPES)[number];

export interface LexEndpoint {
  nsid: string;
  type: LexType;
  description?: string;
}

export interface EndpointIndex {
  queries: LexEndpoint[];
  procedures: LexEndpoint[];
  records: LexEndpoint[];
  subscriptions: LexEndpoint[];
  tokens: LexEndpoint[];
  byNsid: Map<string, LexEndpoint>;
}

let cachedDescriptions: Record<string, string> | null | undefined;
let descriptionsCacheKey: string | null = null;

export function loadDescriptions(
  nsPrefix: string = DEFAULT_NS_PREFIX,
  lexiconsDir: string = LEXICONS_DIR,
): Record<string, string> {
  const cacheKey = `${nsPrefix}::${lexiconsDir}`;
  if (cachedDescriptions !== undefined && descriptionsCacheKey === cacheKey) {
    return cachedDescriptions ?? {};
  }
  const path = join(lexiconsDir, ...nsPrefix.split('.'), '_descriptions.json');
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    cachedDescriptions = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cachedDescriptions = {};
  }
  descriptionsCacheKey = cacheKey;
  return cachedDescriptions ?? {};
}

export function clearDiscoveryCache(): void {
  cache.clear();
  cachedDescriptions = undefined;
  descriptionsCacheKey = null;
}

interface CacheEntry {
  descriptions: Record<string, string> | undefined;
  index: EndpointIndex;
}

const cache = new Map<string, CacheEntry>();

export function discoverEndpoints(
  nsPrefix: string = DEFAULT_NS_PREFIX,
  descriptions?: Record<string, string>,
  lexiconsDir: string = LEXICONS_DIR,
): EndpointIndex {
  const cacheKey = `${nsPrefix}::${lexiconsDir}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.descriptions === descriptions) return cached.index;

  const index = walkLexicons(nsPrefix, descriptions, lexiconsDir);
  cache.set(cacheKey, { descriptions, index });
  return index;
}

function walkLexicons(
  nsPrefix: string,
  descriptions: Record<string, string> | undefined,
  lexiconsDir: string,
): EndpointIndex {
  const buckets: Record<LexType, LexEndpoint[]> = {
    query: [],
    procedure: [],
    record: [],
    subscription: [],
    token: [],
  };
  const byNsid = new Map<string, LexEndpoint>();
  const root = join(lexiconsDir, ...nsPrefix.split('.'));

  walk(root, (filePath, basename) => {
    if (basename.startsWith('_')) return;
    if (basename === 'defs.json') return;

    let lex: { id?: string; defs?: { main?: { type?: string } } };
    try {
      lex = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return;
    }
    if (!lex.id || !lex.defs?.main?.type) return;

    const nsid = lex.id;
    if (nsid !== nsPrefix && !nsid.startsWith(nsPrefix + '.')) return;

    const type = lex.defs.main.type;
    if (!LEX_TYPES.includes(type as LexType)) return;

    const endpoint: LexEndpoint = { nsid, type: type as LexType };
    const desc = descriptions?.[nsid];
    if (desc) endpoint.description = desc;

    buckets[type as LexType].push(endpoint);
    byNsid.set(nsid, endpoint);
  });

  for (const list of Object.values(buckets)) {
    list.sort((a, b) => a.nsid.localeCompare(b.nsid));
  }

  return {
    queries: buckets.query,
    procedures: buckets.procedure,
    records: buckets.record,
    subscriptions: buckets.subscription,
    tokens: buckets.token,
    byNsid,
  };
}

function walk(dir: string, cb: (filePath: string, basename: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, cb);
    } else if (entry.endsWith('.json')) {
      cb(full, entry);
    }
  }
}

export function _resetForTests(): void {
  clearDiscoveryCache();
}
