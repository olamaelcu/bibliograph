import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { logger } from '../logger.js';

interface SnapshotMeta {
  gzSize: number;
  gzMtimeMs: number;
}

export const snapshotPathOf = (gzPath: string): string => `${gzPath}.txt`;

function metaPath(snapshotPath: string): string {
  return `${snapshotPath}.meta`;
}

/**
 * True when the snapshot sidecar matches the current gz file (same size/mtime).
 * A re-downloaded dump invalidates its old snapshot so it is rebuilt.
 */
export function snapshotIsCurrent(gzPath: string, snapshotPath: string): boolean {
  try {
    const gz = statSync(gzPath);
    const meta = JSON.parse(readFileSync(metaPath(snapshotPath), 'utf8')) as SnapshotMeta;
    return meta.gzSize === gz.size && meta.gzMtimeMs === gz.mtimeMs && statSync(snapshotPath).size > 0;
  } catch {
    return false;
  }
}

/** Decompress a gz dump into a plain sidecar; resumes can then byte-seek into it. */
export async function buildSnapshot(gzPath: string, snapshotPath: string): Promise<void> {
  logger.info({ gzPath, snapshotPath }, 'building uncompressed snapshot');
  await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(snapshotPath));
  const gz = statSync(gzPath);
  const meta: SnapshotMeta = { gzSize: gz.size, gzMtimeMs: gz.mtimeMs };
  writeFileSync(metaPath(snapshotPath), JSON.stringify(meta));
}
