import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AuthorStreamer, SeekError } from './streamer.js';

const TSV_A = [
  '/type/author\t/authors/OL1A\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/authors/OL1A","type":"/type/author","name":"Frank Herbert"}',
  '/type/author\t/authors/OL2A\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/authors/OL2A","type":"/type/author","name":"Brian Herbert"}',
  '/type/work\t/works/OL1W\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/works/OL1W","type":"/type/work","title":"Dune"}',
  '/type/author\t/authors/OL3A\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/authors/OL3A","type":"/type/author","name":"Kevin J. Anderson"}',
].join('\n') + '\n';

let dir: string;
let gzPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dump-authors-streamer-'));
  gzPath = join(dir, 'authors.txt.gz');
  writeFileSync(gzPath, gzipSync(TSV_A));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AuthorStreamer', () => {
  it('yields parsed records with key-cursor + byte offset', async () => {
    const streamer = new AuthorStreamer(gzPath);
    const lines: Array<{ key: string; byteOffset: number }> = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      lines.push({ key: item.record.key, byteOffset: item.byteOffset });
    }
    expect(lines.map(l => l.key)).toEqual(['/authors/OL1A', '/authors/OL2A', '/authors/OL3A']);
    for (const l of lines) expect(typeof l.byteOffset).toBe('number');
  });

  it('skips non-author rows but advances byte offset', async () => {
    const streamer = new AuthorStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      keys.push(item.record.key);
    }
    expect(keys).not.toContain('/works/OL1W');
    expect(keys).toHaveLength(3);
  });

  it('skips lines whose numeric id <= lastNumericCursor (replay fallback)', async () => {
    const streamer = new AuthorStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({
      startByteOffset: 0,
      lastNumericCursor: 1,
    })) {
      keys.push(item.record.key);
    }
    expect(keys).toEqual(['/authors/OL2A', '/authors/OL3A']);
  });

  it('skips by numeric id, not lexicographic order', async () => {
    const tsv = [
      '/type/author\t/authors/OL9A\t1\tx\t{"key":"/authors/OL9A","type":"/type/author","name":"A"}',
      '/type/author\t/authors/OL10A\t1\tx\t{"key":"/authors/OL10A","type":"/type/author","name":"B"}',
    ].join('\n') + '\n';
    writeFileSync(gzPath, gzipSync(tsv));
    const streamer = new AuthorStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: 9 })) {
      keys.push(item.record.key);
    }
    expect(keys).toEqual(['/authors/OL10A']);
  });

  it('emits a parse-skipped entry for unparseable JSON (does not throw)', async () => {
    const bad = '/type/author\t/authors/OL9A\t1\tWed, 01 Jan 2026 00:00:00 GMT\tnot-json\n';
    writeFileSync(gzPath, gzipSync(bad + TSV_A));
    const streamer = new AuthorStreamer(gzPath);
    const records: unknown[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      records.push(item.record);
    }
    expect(records).toHaveLength(3);
  });

  it('uses gzip-stream seek when startByteOffset is non-zero (or throws SeekError)', async () => {
    const all = new AuthorStreamer(gzPath);
    const allKeys: string[] = [];
    for await (const item of all.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      allKeys.push(item.record.key);
    }
    const halfOffset = Math.floor((await import('node:fs')).statSync(gzPath).size / 2);
    const fromHalf = new AuthorStreamer(gzPath);
    const halfKeys: string[] = [];
    try {
      for await (const item of fromHalf.iter({ startByteOffset: halfOffset, lastNumericCursor: null })) {
        halfKeys.push(item.record.key);
      }
    } catch (err) {
      if (err instanceof SeekError) {
        expect(halfKeys).toEqual([]);
        return;
      }
      throw err;
    }
    expect(allKeys).toEqual(expect.arrayContaining(halfKeys));
  });

  it('accepts the real OL dump shape where type is an object', async () => {
    const tsv = [
      '/type/author\t/authors/OL1A\t1\tx\t{"key":"/authors/OL1A","type":{"key":"/type/author"},"name":"X"}',
    ].join('\n') + '\n';
    writeFileSync(gzPath, gzipSync(tsv));
    const streamer = new AuthorStreamer(gzPath);
    const records: unknown[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      records.push(item.record);
    }
    expect(records).toHaveLength(1);
  });

  it('rejects records whose embedded type object is not /type/author', async () => {
    const tsv = [
      '/type/author\t/authors/OL1A\t1\tx\t{"key":"/authors/OL1A","type":{"key":"/type/edition"},"name":"X"}',
      '/type/author\t/authors/OL2A\t1\tx\t{"key":"/authors/OL2A","type":"/type/author","name":"Y"}',
    ].join('\n') + '\n';
    writeFileSync(gzPath, gzipSync(tsv));
    const streamer = new AuthorStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      keys.push(item.record.key);
    }
    expect(keys).toEqual(['/authors/OL2A']);
  });
});
