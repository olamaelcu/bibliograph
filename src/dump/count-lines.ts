import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { hasMinFields } from './tsv.js';
import { abortReason } from './interrupt.js';
import { logger } from '../logger.js';

const MIN_FIELDS = 5;

export interface CountDumpLinesOptions {
	/** Read a plain (already-decompressed) file instead of gunzipping. */
	plain?: boolean;
	minFields?: number;
	/** Abort: stop counting and reject at the next line boundary. */
	signal?: AbortSignal;
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
		const onAbort = (): void => {
			lines.close();
			reject(abortReason(opts.signal) ?? new Error('count aborted'));
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		lines.on('line', (line) => {
			if (hasMinFields(line, minFields)) count += 1;
		});
		lines.on('close', () => {
			opts.signal?.removeEventListener('abort', onAbort);
			resolve(count);
		});
		lines.on('error', reject);
		source.on('error', reject);
		if (!plain) input.on('error', reject);
	});
}

interface CountCacheEntry {
	size: number;
	mtimeMs: number;
	lines: number;
	/**
	 * On-disk byte size of the uncompressed snapshot at the time the count was
	 * recorded. Used as a content fingerprint: a gz whose compressed size and
	 * mtime match the cache but whose snapshot size differs (re-downloaded
	 * with denser or sparser records) is treated as stale. Without this, the
	 * bar denominator drifts and shows >100% during imports.
	 */
	snapshotSize?: number;
}

function cachePath(gzPath: string): string {
	return `${gzPath}.count`;
}

function snapshotPathOf(gzPath: string): string {
	return `${gzPath}.txt`;
}

/**
 * Read the cached line count for a dump. Returns null when the cache file is
 * missing or any of its keys no longer match the dump:
 *   - `size` (gz compressed size) differs
 *   - `mtimeMs` (gz mtime) differs
 *   - `snapshotSize` (uncompressed snapshot size) differs from the snapshot on
 *     disk, when a snapshot is present.
 *
 * The snapshot-size check is the content fingerprint that catches a gz
 * re-download where size+mtime happen to match but the record count has
 * changed. When no snapshot exists yet, that check is skipped.
 */
export function readCountCache(gzPath: string): number | null {
	try {
		const st = statSync(gzPath);
		const entry = JSON.parse(readFileSync(cachePath(gzPath), 'utf8')) as CountCacheEntry;
		if (entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) return null;
		if (!Number.isInteger(entry.lines)) return null;
		const snapshotPath = snapshotPathOf(gzPath);
		if (existsSync(snapshotPath)) {
			const snapshotStat = statSync(snapshotPath);
			if (
				entry.snapshotSize === undefined
				|| entry.snapshotSize !== snapshotStat.size
				|| snapshotStat.size === 0
			) {
				return null;
			}
		}
		return entry.lines;
	} catch {
		// missing/invalid cache — caller counts and rewrites
		return null;
	}
}

/**
 * Write the line count for a dump, keyed to (gz size, gz mtime, snapshot
 * size). When `snapshotSize` is omitted, the cache is treated as legacy and
 * `readCountCache` will invalidate it on the next read once a snapshot
 * exists; the next `buildSnapshot` will rewrite the cache with all three keys.
 */
export function writeCountCache(gzPath: string, lines: number, snapshotSize?: number): void {
	try {
		const st = statSync(gzPath);
		const entry: CountCacheEntry = {
			size: st.size,
			mtimeMs: st.mtimeMs,
			lines,
		};
		if (snapshotSize !== undefined) entry.snapshotSize = snapshotSize;
		writeFileSync(cachePath(gzPath), JSON.stringify(entry));
	} catch {
		logger.debug({ gzPath }, 'failed to write dump count cache');
	}
}