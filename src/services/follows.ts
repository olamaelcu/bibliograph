import { Client, simpleFetchHandler } from '@atcute/client';
import type {} from '@atcute/bluesky';

const DEFAULT_SERVICE = 'https://public.api.bsky.app';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_DIDS = 5000;
const MAX_FOLLOWS = 5000;
const FETCH_TIMEOUT_MS = 5000;

interface FollowRow {
  did: string;
}

interface GetFollowsOutput {
  follows: FollowRow[];
  cursor?: string;
}

interface CacheEntry {
  did: string;
  expiresAt: number;
  follows: string[];
}

export class FollowsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly client: Client;

  constructor(service = process.env.ATP_PUBLIC_APPVIEW || DEFAULT_SERVICE) {
    this.client = new Client({ handler: simpleFetchHandler({ service }) });
  }

  async getFollows(did: string): Promise<string[]> {
    const cached = this.cache.get(did);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.follows;
    }

    const follows = await this.fetchFollows(did);
    this.put(did, follows);
    return follows;
  }

  private async fetchFollows(did: string): Promise<string[]> {
    const collected: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.get('app.bsky.graph.getFollows', {
        params: { actor: did as never, limit: 100, cursor },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const err = response.data as { error?: string; message?: string };
        throw new Error(`getFollows failed: ${response.status} ${err.error ?? ''} ${err.message ?? ''}`.trim());
      }

      const data = response.data as GetFollowsOutput;
      collected.push(...data.follows.map((f) => f.did));
      cursor = data.cursor;
    } while (cursor && collected.length < MAX_FOLLOWS);

    return collected.slice(0, MAX_FOLLOWS);
  }

  private put(did: string, follows: string[]): void {
    if (this.cache.has(did)) this.cache.delete(did);
    this.cache.set(did, { did, expiresAt: Date.now() + CACHE_TTL_MS, follows });

    while (this.cache.size > MAX_CACHED_DIDS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
