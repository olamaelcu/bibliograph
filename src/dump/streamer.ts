import type { Readable } from 'node:stream';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { logger } from '../logger.js';

export interface StreamerItem {
  byteOffset: number;
  line: string;
  fields: string[];
}

export interface StreamerOptions {
  /**
   * Informational only: resuming replays from byte 0 and skips via `lastKeyCursor`.
   * Not used as a seek target (gzip is not randomly seekable).
   */
  startByteOffset: number;
  lastKeyCursor: string | null;
  /** Key extraction for resume-skip: return the sortable key or null to always yield. */
  keyOf: (fields: string[]) => string | null;
}

const MIN_FIELDS = 5;

export class SeekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeekError';
  }
}

/**
 * Yields one item per line of a gzipped TSV dump. Resuming from a mid-file
 * byte offset may fail because gzip streams are not randomly seekable — when
 * that happens we throw SeekError and the caller replays from byte 0, skipping
 * records whose key <= lastKeyCursor.
 */
export class DumpStreamer {
  constructor(private readonly gzPath: string) {}

  /**
   * Streams one item per line of the dump.
   *
   * Resuming ALWAYS replays from byte 0 and skips records whose key <= lastKeyCursor.
   * `startByteOffset` is retained for API compatibility, but a mid-file start lands
   * inside the gzip DEFLATE payload (gzip is not randomly seekable) and throws
   * `SeekError`; callers must fall back to byte 0 on `SeekError` and rely on the
   * key-cursor skip for resumption.
   */
  async *iter(opts: StreamerOptions): AsyncGenerator<StreamerItem, void, void> {
    const source: Readable =
      opts.startByteOffset > 0
        ? createReadStream(this.gzPath, { start: opts.startByteOffset })
        : createReadStream(this.gzPath);

    logger.debug({ gzPath: this.gzPath, startByteOffset: opts.startByteOffset, cursor: opts.lastKeyCursor }, 'streaming dump');

    const gunzip = createGunzip();
    const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });

    let runningOffset = opts.startByteOffset;

    try {
      for await (const line of lines) {
        const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
        const lineStart = runningOffset;
        runningOffset += lineByteLen;

        const fields = line.split('\t');
        if (fields.length < MIN_FIELDS) continue;

        const key = opts.keyOf(fields);
        if (key !== null && opts.lastKeyCursor !== null && key <= opts.lastKeyCursor) {
          continue;
        }

        yield { byteOffset: lineStart, line, fields };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.startByteOffset > 0 && /invalid|incorrect/i.test(msg)) {
        const totalSize = statSync(this.gzPath).size;
        throw new SeekError(
          `gunzip failed at byte offset ${opts.startByteOffset}; replay from 0 (file size ${totalSize})`,
        );
      }
      throw err;
    }
  }

  fileSize(): number {
    return statSync(this.gzPath).size;
  }
}
