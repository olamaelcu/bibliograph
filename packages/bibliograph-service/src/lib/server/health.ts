import { createLogger } from './logger';
import { getTapQueueDepth } from './jobs/depth';
import { openLibraryBreaker, googleBooksBreaker, wikipediaBreaker, isbndbBreaker, wikidataBreaker, commonsBreaker } from '../api/breakers';
import { Pool } from 'pg';

const log = createLogger('health');

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  service: { running: boolean; uptimeSec: number };
  database: { reachable: boolean; latencyMs: number };
  worker: { running: boolean; lastSeen?: string };
  tap: { queueDepth: number; threshold: number };
  upstream: Record<string, { state: string; failures: number; openMs?: number }>;
}

let serviceStartedAt = Date.now();
export function markServiceStarted() { serviceStartedAt = Date.now(); }

export async function computeHealth(): Promise<HealthStatus> {
  const now = new Date().toISOString();
  let dbReachable = false;
  let dbLatency = -1;
  try {
    const url = process.env.DATABASE_URL;
    const start = Date.now();
    if (url) {
      const pool = new Pool({ connectionString: url, max: 1 });
      await pool.query('SELECT 1');
      await pool.end();
      dbReachable = true;
    }
    dbLatency = Date.now() - start;
  } catch (err) {
    log.error({ err }, 'database health check failed');
  }

  let queueDepth = 0;
  const threshold = Number(process.env.TAP_QUEUE_DEPTH_THRESHOLD ?? 50_000);
  try { queueDepth = await getTapQueueDepth(); } catch { /* ignore */ }

  const breakers = [
    { name: 'openlibrary', b: openLibraryBreaker },
    { name: 'googlebooks', b: googleBooksBreaker },
    { name: 'wikipedia', b: wikipediaBreaker },
    { name: 'isbndb', b: isbndbBreaker },
    { name: 'wikidata', b: wikidataBreaker },
    { name: 'commons', b: commonsBreaker },
  ];

  const upstream: HealthStatus['upstream'] = {};
  for (const { name, b } of breakers) {
    upstream[name] = {
      state: b.getState(),
      failures: b.getFailures(),
    };
  }

  const degraded = !dbReachable || queueDepth > threshold / 2 || Object.values(upstream).some(u => u.state === 'open');

  return {
    status: dbReachable ? (degraded ? 'degraded' : 'healthy') : 'unhealthy',
    timestamp: now,
    service: { running: true, uptimeSec: Math.floor((Date.now() - serviceStartedAt) / 1000) },
    database: { reachable: dbReachable, latencyMs: dbLatency },
    worker: { running: true, lastSeen: now },
    tap: { queueDepth, threshold },
    upstream,
  };
}
