import type { Logger } from 'pino';
import type { ContributorItem } from '../search/types';
import { requestJson } from '../http/client';

const BASE = 'https://en.wikipedia.org/w/api.php';

interface WikiQueryResponse { query?: { pages?: Record<string, { extract?: string; title?: string; missing?: string }> }; }

const CHUNK_SIZE = 50;

async function fetchExtracts(names: string[], log: Logger, signal?: AbortSignal): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const merged = new Map<string, string>();
  // Chunk to avoid hitting Wikipedia's URL length cap (~8 KB) for long name lists.
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += CHUNK_SIZE) {
    chunks.push(names.slice(i, i + CHUNK_SIZE));
  }
  // The chunks are independent GETs, so ask for them concurrently; a long
  // author list used to cost one round trip per 50 names in sequence.
  const pages = await Promise.all(chunks.map(async (chunk) => {
    const url = `${BASE}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(chunk.join('|'))}`;
    const start = performance.now();
    try {
      const data = await requestJson<WikiQueryResponse>(url, { signal });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!data) return [];
      const pageMap = data.query?.pages ?? {};
      const found: Array<[string, string]> = [];
      for (const page of Object.values(pageMap)) {
        if (page.missing) continue;
        if (page.extract && page.title) {
          const clean = page.extract.replace(/\s+/g, ' ').trim().slice(0, 2048);
          found.push([page.title, clean]);
        }
      }
      log.info({ stage: 'wikipedia-enricher', requested: chunk.length, matched: found.length, durationMs }, 'wikipedia ok');
      return found;
    } catch (err) {
      log.error({ stage: 'wikipedia-enricher', err }, 'wikipedia fetch failed');
      return [];
    }
  }));
  for (const found of pages) for (const [title, extract] of found) merged.set(title, extract);
  return merged;
}

export async function enrichContributorBios(
  items: readonly ContributorItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<ContributorItem[]> {
  const nameMap = new Map<string, string>(); // lowercased -> original
  for (const it of items) nameMap.set(it.name.toLowerCase(), it.name);
  const unique = Array.from(nameMap.values());
  const extracts = await fetchExtracts(unique, log, externalSignal);
  return items.map((it) => {
    const title = Array.from(extracts.keys()).find((t) => t.toLowerCase() === it.name.toLowerCase());
    if (!title) return it;
    const bio = extracts.get(title);
    if (!bio) return it;
    return { ...it, bio };
  });
}


