import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildSnapshot, snapshotIsCurrent, snapshotPathOf } from './snapshot.js';

describe('snapshot', () => {
	let dir: string;
	let gzPath: string;
	let snapshotPath: string;
	const lines = [
		'a\tOL1A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL1A","name":"Alpha"}',
		'b\tOL2A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL2A","name":"Beta"}',
		'c\tOL3A\t1\t2026-01-01T00:00:00Z\t{"key":"/authors/OL3A","name":"Gamma"}',
	].join('\n') + '\n';

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'snapshot-'));
		gzPath = join(dir, 'dump.txt.gz');
		snapshotPath = snapshotPathOf(gzPath);
		writeFileSync(gzPath, gzipSync(lines));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('buildSnapshot writes the snapshot and the meta with decompressedSize', async () => {
		await buildSnapshot(gzPath, snapshotPath);
		expect(existsSync(snapshotPath)).toBe(true);
		const meta = JSON.parse(readFileSync(`${snapshotPath}.meta`, 'utf8')) as {
			gzSize: number;
			gzMtimeMs: number;
			decompressedSize: number;
		};
		expect(meta.gzSize).toBe(statSync(gzPath).size);
		expect(meta.gzMtimeMs).toBe(statSync(gzPath).mtimeMs);
		expect(meta.decompressedSize).toBe(statSync(snapshotPath).size);
		expect(meta.decompressedSize).toBeGreaterThan(0);
	});

	it('snapshotIsCurrent returns true after a clean build', async () => {
		await buildSnapshot(gzPath, snapshotPath);
		expect(snapshotIsCurrent(gzPath, snapshotPath)).toBe(true);
	});

	it('snapshotIsCurrent returns false when the snapshot file is truncated', async () => {
		// Regression for the 2026-08 contributors import: a half-built snapshot
		// (pipeline interrupted mid-decompress) used to pass the check because
		// the meta only had (gzSize, mtimeMs). The strengthened check requires
		// the on-disk snapshot size to match the recorded `decompressedSize`.
		await buildSnapshot(gzPath, snapshotPath);
		const size = statSync(snapshotPath).size;
		truncateSync(snapshotPath, Math.floor(size / 2));
		expect(snapshotIsCurrent(gzPath, snapshotPath)).toBe(false);
	});

	it('snapshotIsCurrent returns false when the meta is missing', () => {
		expect(snapshotIsCurrent(gzPath, snapshotPath)).toBe(false);
	});

	it('snapshotIsCurrent returns false when the meta is in the old (pre-decompressedSize) format', async () => {
		// Simulate a snapshot built by an older version of the code that
		// did not record `decompressedSize`. The check should treat the meta
		// as stale so the next run rebuilds.
		await buildSnapshot(gzPath, snapshotPath);
		const metaPath = `${snapshotPath}.meta`;
		const oldMeta = {
			gzSize: statSync(gzPath).size,
			gzMtimeMs: statSync(gzPath).mtimeMs,
		};
		writeFileSync(metaPath, JSON.stringify(oldMeta));
		expect(snapshotIsCurrent(gzPath, snapshotPath)).toBe(false);
	});
});
