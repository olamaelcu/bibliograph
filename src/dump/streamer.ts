import type { Readable } from 'node:stream';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { DumpEditionRecord } from './edition-mapper.js';

export interface StreamerItem {
  byteOffset: number;
  record: DumpEditionRecord;
}

export interface StreamerOptions {
  startByteOffset: number;
  resumeAfterKey: string | null;
}

const EDITION_TYPE = '/type/edition';

export class DumpStreamer {
  constructor(private readonly gzPath: string) {}

  async *iter(opts: StreamerOptions): AsyncGenerator<StreamerItem, void, void> {
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
        if (type !== EDITION_TYPE) continue;
        if (!key) continue;

        if (opts.resumeAfterKey && key <= opts.resumeAfterKey) continue;

        let record: DumpEditionRecord;
        try {
          record = JSON.parse(fields[4]) as DumpEditionRecord;
        } catch {
          continue;
        }

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
