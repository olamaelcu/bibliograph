import type { Readable } from 'node:stream';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { hasMinFields, tsvField } from './tsv.js';
import { logger } from '../logger.js';

export interface StreamerItem {
  byteOffset: number;
  line: string;
  /** Resume-sortable key (defaults to the 2nd TSV field), null when the line has none. */
  key: string | null;
}

export interface StreamerOptions {
  /**
   * Informational only for gzip sources (gzip is not randomly seekable). For a
   * plain source it is a real byte seek target, and resuming reads from there.
   */
  startByteOffset: number;
  lastKeyCursor: string | null;
  /** Key extraction for resume-skip: return the sortable key or null to always yield. */
  keyOf?: (line: string) => string | null;
  /** Abort: stop iterating at the next line boundary. */
  signal?: AbortSignal;
}

const MIN_FIELDS = 5;

const defaultKeyOf = (line: string): string | null => tsvField(line, 1);

export class SeekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeekError';
  }
}

/**
 * Yields one item per line of a dump. The default source is a gzipped TSV dump;
 * pass `{ plain: true }` to read a plain (already-decompressed) copy so a
 * mid-file `startByteOffset` becomes a real seek instead of a SeekError.
 *
 * Resuming a gzip source always replays from byte 0 and skips records whose key
 * <= lastKeyCursor. Resuming a plain source seeks to `startByteOffset` directly.
 */
export class DumpStreamer {
  constructor(
    private readonly path: string,
    private readonly plain = false,
  ) {}

  async *iter(opts: StreamerOptions): AsyncGenerator<StreamerItem, void, void> {
    const source: Readable =
      opts.startByteOffset > 0
        ? createReadStream(this.path, { start: opts.startByteOffset })
        : createReadStream(this.path);
    const input: Readable = this.plain ? source : source.pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });

    const onAbort = (): void => {
      // Closing readline stops the for-await loop cleanly at the next boundary.
      lines.close();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      logger.debug({ path: this.path, plain: this.plain, startByteOffset: opts.startByteOffset, cursor: opts.lastKeyCursor }, 'streaming dump');

      const keyOf = opts.keyOf ?? defaultKeyOf;
      let runningOffset = opts.startByteOffset;

      for await (const line of lines) {
        if (opts.signal?.aborted) break;
        const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
        const lineStart = runningOffset;
        runningOffset += lineByteLen;

        if (!hasMinFields(line, MIN_FIELDS)) continue;

        const key = keyOf(line);
        if (key !== null && opts.lastKeyCursor !== null && key <= opts.lastKeyCursor) {
          continue;
        }

        yield { byteOffset: lineStart, line, key };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!this.plain && opts.startByteOffset > 0 && /invalid|incorrect/i.test(msg)) {
        const totalSize = statSync(this.path).size;
        throw new SeekError(
          `gunzip failed at byte offset ${opts.startByteOffset}; replay from 0 (file size ${totalSize})`,
        );
      }
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      lines.close();
    }
  }

  fileSize(): number {
    return statSync(this.path).size;
  }
}
