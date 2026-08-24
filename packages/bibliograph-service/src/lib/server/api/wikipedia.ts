import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import type { ContributorItem, EditionItem, WorkItem } from '../search/types';

const BASE = 'https://en.wikipedia.org/w/api.php';

interface WikiQueryResponse { query?: { pages?: Record<string, { extract?: string; title?: string; missing?: string }> }; }

const CHUNK_SIZE = 50;

async function fetchExtracts(names: string[], log: Logger, signal?: AbortSignal): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const merged = new Map<string, string>();
  // Chunk to avoid hitting Wikipedia's URL length cap (~8 KB) for long name lists.
  for (let i = 0; i < names.length; i += CHUNK_SIZE) {
    const chunk = names.slice(i, i + CHUNK_SIZE);
    const url = `${BASE}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(chunk.join('|'))}`;
    const start = performance.now();
    try {
      const effectiveSignal = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const res = await fetch(url, { signal: effectiveSignal });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!res.ok) {
        log.warn({ stage: 'wikipedia-enricher', status: res.status, names: chunk.length }, 'wikipedia non-2xx');
        continue;
      }
      const data = (await res.json()) as WikiQueryResponse;
      const pages = data.query?.pages ?? {};
      for (const page of Object.values(pages)) {
        if (page.missing) continue;
        if (page.extract && page.title) {
          const clean = page.extract.replace(/\s+/g, ' ').trim().slice(0, 2048);
          merged.set(page.title, clean);
        }
      }
      log.info({ stage: 'wikipedia-enricher', requested: chunk.length, matched: merged.size, durationMs }, 'wikipedia ok');
    } catch (err) {
      log.error({ stage: 'wikipedia-enricher', err }, 'wikipedia fetch failed');
    }
  }
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

export async function enrichAuthorsOnWorksOrEditions(
  items: ReadonlyArray<EditionItem | WorkItem>,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<Array<EditionItem | WorkItem>> {
  // For MVP, the author-bio lookup on works/editions is a no-op; the
  // contributor record (which has a `bio` field) is enriched separately via
  // enrichContributorBios. This keeps the contract stable for the orchestrator.
  return [...items];
}
