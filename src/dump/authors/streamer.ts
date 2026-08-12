/**
 * Author-dump gzip line streamer.
 *
 * Mirrors the structure of `src/dump/streamer.ts` but filters on
 * `/type/author` rows. The authors dump is ~1.5 GB compressed so we stream
 * line-by-line rather than loading the file into memory.
 */

import type { Readable } from 'node:stream';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { DumpAuthorRecord } from './mapper.js';

export interface AuthorStreamerItem {
  byteOffset: number;
  record: DumpAuthorRecord;
}

export interface AuthorStreamerOptions {
  startByteOffset: number;
  lastNumericCursor: number | null;
}

const AUTHOR_TYPE = '/type/author';

export class AuthorStreamer {
  constructor(private readonly gzPath: string) {}

  async *iter(opts: AuthorStreamerOptions): AsyncGenerator<AuthorStreamerItem, void, void> {
    const source: Readable =
      opts.startByteOffset > 0
        ? createReadStream(this.gzPath, { start: opts.startByteOffset })
        : createReadStream(this.gzPath);

    const gunzip = createGunzip();
    const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });

    let runningOffset = opts.startByteOffset;

    try {
      for await (const line of lines) {
        const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
        const lineStart = runningOffset;
        runningOffset += lineByteLen;

        const fields = line.split('\t');
        if (fields.length < 5) continue;
        const [type, key] = fields;
        if (extractTypeKey(type) !== AUTHOR_TYPE) continue;
        if (!key) continue;

        const candidateId = parseAuthorId(key);
        if (opts.lastNumericCursor !== null && candidateId !== null && candidateId <= opts.lastNumericCursor) {
          continue;
        }

        let record: DumpAuthorRecord;
        try {
          record = JSON.parse(fields[4]) as DumpAuthorRecord;
        } catch {
          continue;
        }

        if (extractTypeKey(record.type) !== AUTHOR_TYPE) continue;

        yield { byteOffset: lineStart, record };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (opts.startByteOffset > 0 && /invalid|incorrect/i.test(msg)) {
        const totalSize = statSync(this.gzPath).size;
        throw new SeekError(
          `gunzip failed at byte offset ${opts.startByteOffset}; caller must fall back to replay from 0. File size: ${totalSize}.`,
        );
      }
      throw err;
    }
  }

  fileSize(): number {
    return statSync(this.gzPath).size;
  }
}

export class SeekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeekError';
  }
}

export function parseAuthorId(key: string): number | null {
  const m = /\/authors\/OL(\d+)A$/.exec(key);
  return m ? Number(m[1]) : null;
}

function extractTypeKey(type: unknown): string | null {
  if (typeof type === 'string') return type;
  if (type && typeof type === 'object' && typeof (type as { key?: unknown }).key === 'string') {
    return (type as { key: string }).key;
  }
  return null;
}
