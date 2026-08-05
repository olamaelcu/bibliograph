import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DumpStreamer, SeekError } from './streamer.js';

const TSV_A = [
  '/type/edition\t/books/OL1M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL1M","type":"/type/edition","title":"Dune","isbn_13":["9780441172719"]}',
  '/type/edition\t/books/OL2M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL2M","type":"/type/edition","title":"Dune Messiah","isbn_13":["9780441172726"]}',
  '/type/work\t/works/OL1W\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/works/OL1W","type":"/type/work","title":"Dune"}',
  '/type/edition\t/books/OL3M\t1\tWed, 01 Jan 2026 00:00:00 GMT\t{"key":"/books/OL3M","type":"/type/edition","title":"Children of Dune","isbn_10":["0441104022"]}',
].join('\n') + '\n';

let dir: string;
let gzPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dump-streamer-'));
  gzPath = join(dir, 'dump.txt.gz');
  writeFileSync(gzPath, gzipSync(TSV_A));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DumpStreamer', () => {
  it('yields parsed records with key-cursor + byte offset', async () => {
    const streamer = new DumpStreamer(gzPath);
    const lines: Array<{ key: string; byteOffset: number }> = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      lines.push({ key: item.record.key, byteOffset: item.byteOffset });
    }
    expect(lines.map(l => l.key)).toEqual(['/books/OL1M', '/books/OL2M', '/books/OL3M']);
    for (const l of lines) expect(typeof l.byteOffset).toBe('number');
  });

  it('skips non-edition rows but advances byte offset', async () => {
    const streamer = new DumpStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      keys.push(item.record.key);
    }
    expect(keys).not.toContain('/works/OL1W');
    expect(keys).toHaveLength(3);
  });

  it('skips lines whose numeric id <= lastNumericCursor (replay fallback)', async () => {
    const streamer = new DumpStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({
      startByteOffset: 0,
      lastNumericCursor: 1,
    })) {
      keys.push(item.record.key);
    }
    expect(keys).toEqual(['/books/OL2M', '/books/OL3M']);
  });

  it('skips by numeric id, not lexicographic order', async () => {
    const tsv = [
      '/type/edition\t/books/OL9M\t1\tx\t{"key":"/books/OL9M","type":"/type/edition","title":"A"}',
      '/type/edition\t/books/OL10M\t1\tx\t{"key":"/books/OL10M","type":"/type/edition","title":"B"}',
    ].join('\n') + '\n';
    writeFileSync(gzPath, gzipSync(tsv));
    const streamer = new DumpStreamer(gzPath);
    const keys: string[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: 9 })) {
      keys.push(item.record.key);
    }
    expect(keys).toEqual(['/books/OL10M']);
  });

  it('emits a parse-skipped entry for unparseable JSON (does not throw)', async () => {
    const bad = '/type/edition\t/books/OL9M\t1\tWed, 01 Jan 2026 00:00:00 GMT\tnot-json\n';
    writeFileSync(gzPath, gzipSync(bad + TSV_A));
    const streamer = new DumpStreamer(gzPath);
    const records: unknown[] = [];
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      records.push(item.record);
    }
    expect(records).toHaveLength(3);
  });

  it('uses gzip-stream seek when startByteOffset is non-zero (or throws SeekError)', async () => {
    const all = new DumpStreamer(gzPath);
    const allKeys: string[] = [];
    for await (const item of all.iter({ startByteOffset: 0, lastNumericCursor: null })) {
      allKeys.push(item.record.key);
    }
    const halfOffset = Math.floor((await import('node:fs')).statSync(gzPath).size / 2);
    const fromHalf = new DumpStreamer(gzPath);
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
});