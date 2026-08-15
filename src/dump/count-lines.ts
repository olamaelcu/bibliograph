import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { logger } from '../logger.js';

const MIN_FIELDS = 5;

/**
 * Count the lines in a gzipped dump by streaming a full decompression pass.
 * Lines that don't split into at least `MIN_FIELDS` tab-separated fields are
 * skipped, mirroring DumpStreamer so the count matches what importInBatches
 * will actually process. This is an exact count at the cost of one extra
 * gunzip pass over the file.
 */
export function countDumpLines(gzPath: string, minFields = MIN_FIELDS): Promise<number> {
	return new Promise((resolve, reject) => {
		const gunzip = createGunzip();
		const lines = createInterface({
			input: createReadStream(gzPath).pipe(gunzip),
			crlfDelay: Infinity,
		});
		let count = 0;
		lines.on('line', (line) => {
			if (line.split('\t').length >= minFields) count += 1;
		});
		lines.on('close', () => resolve(count));
		lines.on('error', reject);
		gunzip.on('error', reject);
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
