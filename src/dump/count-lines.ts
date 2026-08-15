import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { hasMinFields } from './tsv.js';
import { logger } from '../logger.js';

const MIN_FIELDS = 5;

export interface CountDumpLinesOptions {
  /** Read a plain (already-decompressed) file instead of gunzipping. */
  plain?: boolean;
  minFields?: number;
}

/**
 * Count the records in a dump by streaming. Gzip sources need a full
 * decompression pass; plain sources read directly. Lines that don't split into
 * at least `minFields` fields are skipped, mirroring DumpStreamer so the count
 * matches what importInBatches will actually process. This is an exact count at
 * the cost of one extra pass over the file.
 */
export function countDumpLines(path: string, opts: CountDumpLinesOptions = {}): Promise<number> {
  const minFields = opts.minFields ?? MIN_FIELDS;
  const plain = opts.plain ?? false;
  return new Promise((resolve, reject) => {
    const source: Readable = createReadStream(path);
    const input: Readable = plain ? source : source.pipe(createGunzip());
    const lines = createInterface({
      input,
      crlfDelay: Infinity,
    });
    let count = 0;
    lines.on('line', (line) => {
      if (hasMinFields(line, minFields)) count += 1;
    });
    lines.on('close', () => resolve(count));
    lines.on('error', reject);
    source.on('error', reject);
    if (!plain) input.on('error', reject);
  });
}

interface CountCacheEntry {
  size: number;
  mtimeMs: number;
  lines: number;
}

function cachePath(gzPath: string): string {
  return `${gzPath}.count`;
}

/**
 * Read the cached line count for a dump. Returns null when the cache file is
 * missing or its recorded size/mtime no longer match the dump file, so a
 * re-downloaded dump never reuses a stale count.
 */
export function readCountCache(gzPath: string): number | null {
  try {
    const st = statSync(gzPath);
    const entry = JSON.parse(readFileSync(cachePath(gzPath), 'utf8')) as CountCacheEntry;
    if (entry.size === st.size && entry.mtimeMs === st.mtimeMs && Number.isInteger(entry.lines)) {
      return entry.lines;
    }
  } catch {
    // missing/invalid cache — caller counts and rewrites
  }
  return null;
}

/** Write the line count for a dump, keyed to the file's current size/mtime. */
export function writeCountCache(gzPath: string, lines: number): void {
  try {
    const st = statSync(gzPath);
    const entry: CountCacheEntry = { size: st.size, mtimeMs: st.mtimeMs, lines };
    writeFileSync(cachePath(gzPath), JSON.stringify(entry));
  } catch {
    logger.debug({ gzPath }, 'failed to write dump count cache');
  }
}
