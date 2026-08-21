import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { countDumpLines, readCountCache, writeCountCache } from './count-lines.js';

const lines = [
	'a\tOL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha"}',
	'b\tOL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta"}',
	'c\tOL3A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL3A","name":"Gamma"}',
].join('\n') + '\n';

describe('count-lines', () => {
	let dir: string;
	let gzPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'count-lines-'));
		gzPath = join(dir, 'dump.txt.gz');
		writeFileSync(gzPath, gzipSync(lines));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('counts lines with >=5 fields in a gz source', async () => {
		const total = await countDumpLines(gzPath);
		expect(total).toBe(3);
	});

	it('round-trips the count cache via (size, mtime)', () => {
		const before = readCountCache(gzPath);
		expect(before).toBeNull();
		writeCountCache(gzPath, 3);
		expect(readCountCache(gzPath)).toBe(3);
	});

	it('invalidates the count cache when the gz size changes', () => {
		writeCountCache(gzPath, 3);
		// Overwrite the gz with different content of a different size.
		writeFileSync(gzPath, gzipSync(lines + 'extra\n'));
		expect(statSync(gzPath).size).not.toBe(readCountCache.length as unknown as number);
		expect(readCountCache(gzPath)).toBeNull();
	});

	it('invalidates the count cache when the gz mtime changes', () => {
		writeCountCache(gzPath, 3);
		// Bump the mtime by re-writing and setting explicit times.
		const cached = readCountCache(gzPath);
		expect(cached).toBe(3);
		const future = (statSync(gzPath).mtimeMs + 60_000) / 1000;
		utimesSync(gzPath, future, future);
		expect(readCountCache(gzPath)).toBeNull();
	});

	it('snapshot size in the cache prevents stale reuse after a re-downloaded gz', () => {
		// Regression for the 2026-08 ol-works import: the cache's (size, mtime)
		// keys both still matched a re-downloaded gz, but the record count had
		// changed. The new `snapshotSize` key is a content fingerprint: if the
		// snapshot's on-disk size differs from the cached value, the cache is
		// invalidated.
		const snapshotPath = `${gzPath}.txt`;
		writeFileSync(snapshotPath, 'first-build-content');
		const firstSize = statSync(snapshotPath).size;
		writeCountCache(gzPath, 100, firstSize);
		expect(readCountCache(gzPath)).toBe(100);

		// Simulate a partial build: snapshot shrunk (interrupted decompress).
		writeFileSync(snapshotPath, 'shorter');
		expect(readCountCache(gzPath)).toBeNull();
	});

	it('snapshot size check is skipped when no snapshot exists', () => {
		// Without a snapshot on disk, the (size, mtime) keys are sufficient.
		writeCountCache(gzPath, 3, /* snapshotSize */ undefined);
		expect(readCountCache(gzPath)).toBe(3);
	});

	it('legacy cache entries (no snapshotSize) are invalidated once a snapshot exists', () => {
		// Mimic an old cache that didn't record snapshotSize.
		const cachePath = `${gzPath}.count`;
		const st = statSync(gzPath);
		writeFileSync(
			cachePath,
			JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, lines: 42 }),
		);
		// No snapshot yet — legacy cache reads fine.
		expect(readCountCache(gzPath)).toBe(42);

		// Snapshot now exists but size is unknown to the legacy cache.
		writeFileSync(`${gzPath}.txt`, 'content');
		expect(readCountCache(gzPath)).toBeNull();
	});
});