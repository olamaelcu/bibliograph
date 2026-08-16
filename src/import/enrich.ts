import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { contributors, works } from '../db/schema.js';
import { DumpStreamer } from '../dump/streamer.js';
import { importInBatches } from '../dump/batched-importer.js';
import { splitTsv } from '../dump/tsv.js';
import { text, unixSecondsOrNull } from './mappers/openlibrary.js';
import { logger } from '../logger.js';

type Database = NodePgDatabase<typeof schema>;

export interface EnrichResult {
  processed: number;
  enriched: number;
  failed: number;
}

export interface EnrichOptions {
  dumpPath?: string;
  batchSize?: number;
  /** Abort: stop the enrichment at the next batch boundary. */
  signal?: AbortSignal;
}

interface Target {
  pk: string;
  [k: string]: unknown;
}

type Apply = (tx: Database, target: Target, rec: Record<string, unknown>) => Promise<boolean>;

/**
 * Stream a local dump and run `apply` only for records whose key is in
 * `targets`. Out-of-set records are skipped without being split or parsed, so
 * a large dump scans at bare decompression speed when the need-set is small.
 */
async function runEnrichment(
  db: Database,
  opts: { gzPath: string; targets: ReadonlyMap<string, Target>; batchSize?: number; apply: Apply; signal?: AbortSignal },
): Promise<EnrichResult> {
  const items = new DumpStreamer(opts.gzPath).iter({ startByteOffset: 0, lastKeyCursor: null, signal: opts.signal });
  const summary = await importInBatches(db, items, {
    batchSize: opts.batchSize ?? 500,
    signal: opts.signal,
    upsert: async (tx, item) => {
      if (item.key === null) return { action: 'skipped' };
      const target = opts.targets.get(item.key);
      if (target === undefined) return { action: 'skipped' };
      try {
        const fields = splitTsv(item.line, 5);
        const rec = JSON.parse(fields[4]) as Record<string, unknown>;
        return { action: (await opts.apply(tx, target, rec)) ? 'inserted' : 'skipped' };
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'enrichment record failed');
        return { action: 'failed' };
      }
    },
  });
  return { processed: summary.processed, enriched: summary.inserted, failed: summary.failed };
}

function dumpGzPath(opts: EnrichOptions, stateName: string): string {
  const dumpDir = resolve(opts.dumpPath ?? process.env.OL_DUMP_PATH ?? resolve(process.cwd(), 'data', 'dumps'));
  return resolve(dumpDir, `${stateName}.txt.gz`);
}

async function contributorTargets(db: Database): Promise<Map<string, Target>> {
  const result = await db.execute(
    `SELECT c.pk AS pk, ci.resource AS resource, (c.bio IS NULL)::int AS need_bio, (c.sort_name IS NULL)::int AS need_sort
     FROM contributor_identifiers ci
     JOIN contributors c ON c.pk = ci.contributor_pk
     WHERE ci.resource LIKE 'openlibrary:authors/%'
       AND c.release_status = 'released'
       AND (c.bio IS NULL OR c.sort_name IS NULL)`,
  );
  const rows = result.rows as Array<{ pk: string; resource: string; need_bio: number; need_sort: number }>;
  const targets = new Map<string, Target>();
  for (const r of rows) {
    targets.set('/' + r.resource.slice('openlibrary:'.length), {
      pk: r.pk,
      needBio: r.need_bio === 1,
      needSort: r.need_sort === 1,
    });
  }
  return targets;
}

async function applyContributor(tx: Database, target: Target, rec: Record<string, unknown>): Promise<boolean> {
  const bio = text(rec.bio as string | { value?: string } | undefined);
  const sortName = typeof rec.personal_name === 'string' ? rec.personal_name : null;
  const sets: Record<string, unknown> = {};
  if (target.needBio === true && bio != null) sets.bio = bio;
  if (target.needSort === true && sortName != null) sets.sortName = sortName;
  if (Object.keys(sets).length === 0) return false;
  const res = await tx.update(contributors).set(sets).where(eq(contributors.pk, target.pk));
  return (res.rowCount ?? 0) > 0;
}

/**
 * Fill null bio/sortName on released contributors by re-reading the local
 * authors dump. Only null fields are written; existing values are never
 * overwritten.
 */
export async function enrichContributors(db: Database, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const gzPath = dumpGzPath(opts, 'ol-authors');
  if (!existsSync(gzPath)) {
    throw new Error(`authors dump not found at ${gzPath}; run 'contributors:dump --keep-dump' first`);
  }
  const targets = await contributorTargets(db);
  logger.info({ gzPath, eligible: targets.size }, 'contributors enrichment started');
  if (targets.size === 0) return { processed: 0, enriched: 0, failed: 0 };
  const res = await runEnrichment(db, { gzPath, targets, batchSize: opts.batchSize, apply: applyContributor, signal: opts.signal });
  logger.info({ ...res }, 'contributors enrichment complete');
  return res;
}

async function workTargets(db: Database): Promise<Map<string, Target>> {
  const result = await db.execute(
    `SELECT w.pk AS pk, wi.resource AS resource
     FROM work_identifiers wi
     JOIN works w ON w.pk = wi.work_pk
     WHERE wi.resource LIKE 'openlibrary:works/%'
       AND w.release_status = 'released'
       AND w.original_publish_date IS NULL`,
  );
  const rows = result.rows as Array<{ pk: string; resource: string }>;
  const targets = new Map<string, Target>();
  for (const r of rows) targets.set('/' + r.resource.slice('openlibrary:'.length), { pk: r.pk });
  return targets;
}

async function applyWork(tx: Database, target: Target, rec: Record<string, unknown>): Promise<boolean> {
  const od = unixSecondsOrNull(typeof rec.first_publish_date === 'string' ? rec.first_publish_date : undefined);
  if (od == null) return false;
  const res = await tx.update(works).set({ originalPublishDate: Number(od) }).where(eq(works.pk, target.pk));
  return (res.rowCount ?? 0) > 0;
}

/** Fill null original publish dates on released works by re-reading the local works dump. */
export async function enrichWorks(db: Database, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const gzPath = dumpGzPath(opts, 'ol-works');
  if (!existsSync(gzPath)) {
    throw new Error(`works dump not found at ${gzPath}; run 'works:dump --keep-dump' first`);
  }
  const targets = await workTargets(db);
  logger.info({ gzPath, eligible: targets.size }, 'works enrichment started');
  if (targets.size === 0) return { processed: 0, enriched: 0, failed: 0 };
  const res = await runEnrichment(db, { gzPath, targets, batchSize: opts.batchSize, apply: applyWork, signal: opts.signal });
  logger.info({ ...res }, 'works enrichment complete');
  return res;
}
