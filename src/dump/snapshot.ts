import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { logger } from '../logger.js';

interface SnapshotMeta {
	gzSize: number;
	gzMtimeMs: number;
	/**
	 * Decompressed size of the gz in bytes, captured at build time. Compared
	 * against the on-disk snapshot size on every `snapshotIsCurrent` call so
	 * an interrupted build (snapshot smaller than expected) is treated as
	 * stale and rebuilt. Without this check, a half-built snapshot would
	 * pass validation and cause the streamer to hit EOF prematurely.
	 */
	decompressedSize: number;
}

export const snapshotPathOf = (gzPath: string): string => `${gzPath}.txt`;

function metaPath(snapshotPath: string): string {
	return `${snapshotPath}.meta`;
}

/**
 * True when the snapshot sidecar matches the current gz file (same size/mtime
 * AND same decompressed size as recorded at build time) and is non-empty.
 * The decompressed-size check rejects partial builds whose pipeline was
 * interrupted before the full gz was decoded — those snapshots pass the gz
 * size/mtime check but silently truncate the import at their EOF.
 */
export function snapshotIsCurrent(gzPath: string, snapshotPath: string): boolean {
	try {
		const gz = statSync(gzPath);
		const meta = JSON.parse(readFileSync(metaPath(snapshotPath), 'utf8')) as SnapshotMeta;
		if (meta.decompressedSize === undefined) {
			// Older meta file from before the truncation check landed — treat as
			// stale so the next run rebuilds with the new format.
			return false;
		}
		return (
			meta.gzSize === gz.size
			&& meta.gzMtimeMs === gz.mtimeMs
			&& meta.decompressedSize === statSync(snapshotPath).size
			&& meta.decompressedSize > 0
		);
	} catch {
		return false;
	}
}

/** Decompress a gz dump into a plain sidecar; resumes can then byte-seek into it. */
export async function buildSnapshot(gzPath: string, snapshotPath: string, signal?: AbortSignal): Promise<void> {
	logger.info({ gzPath, snapshotPath }, 'building uncompressed snapshot');
	await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(snapshotPath), { signal });
	// Write the meta AFTER the pipeline completes. If the build is interrupted,
	// the meta is missing (or the snapshot is shorter than `decompressedSize`
	// on a retry), so the next `snapshotIsCurrent` call rebuilds.
	const gz = statSync(gzPath);
	const meta: SnapshotMeta = {
		gzSize: gz.size,
		gzMtimeMs: gz.mtimeMs,
		decompressedSize: statSync(snapshotPath).size,
	};
	writeFileSync(metaPath(snapshotPath), JSON.stringify(meta));
}
