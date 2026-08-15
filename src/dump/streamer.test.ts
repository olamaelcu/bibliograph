import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DumpStreamer, SeekError } from './streamer.js';
import { tsvField } from './tsv.js';

function fixture(lines: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dump-streamer-'));
  const path = join(dir, 'fixture.txt.gz');
  writeFileSync(path, gzipSync(lines.join('\n') + '\n'));
  return { dir, path };
}

function plainFixture(lines: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dump-streamer-plain-'));
  const path = join(dir, 'fixture.txt');
  writeFileSync(path, lines.join('\n') + '\n');
  return { dir, path };
}

const keyOf = (line: string) => tsvField(line, 1);

describe('DumpStreamer', () => {
  it('yields all lines with byte offsets and a lazily extracted key', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}', 'c\tOL3M\t0\tx\t{}']);
    try {
      const items: Array<{ offset: number; key: string }> = [];
      for await (const it of new DumpStreamer(path).iter({ startByteOffset: 0, lastKeyCursor: null, keyOf })) {
        items.push({ offset: it.byteOffset, key: it.key! });
      }
      expect(items.map((i) => i.key)).toEqual(['OL1M', 'OL2M', 'OL3M']);
      expect(items[0].offset).toBe(0);
      expect(items[1].offset).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults keyOf to the 2nd TSV field', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}']);
    try {
      const keys: string[] = [];
      for await (const it of new DumpStreamer(path).iter({ startByteOffset: 0, lastKeyCursor: null })) {
        keys.push(it.key!);
      }
      expect(keys).toEqual(['OL1M', 'OL2M']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips lines with key <= lastKeyCursor', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}', 'c\tOL3M\t0\tx\t{}']);
    try {
      const keys: string[] = [];
      for await (const it of new DumpStreamer(path).iter({ startByteOffset: 0, lastKeyCursor: 'OL2M', keyOf })) {
        keys.push(it.key!);
      }
      expect(keys).toEqual(['OL3M']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a plain file from a byte offset (snapshot resume)', async () => {
    const lines = ['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}', 'c\tOL3M\t0\tx\t{}'];
    const { dir, path } = plainFixture(lines);
    try {
      const line1Bytes = Buffer.byteLength(lines[0], 'utf8') + 1;
      const keys: string[] = [];
      for await (const it of new DumpStreamer(path, { plain: true }).iter({
        startByteOffset: line1Bytes,
        lastKeyCursor: null,
        keyOf,
      })) {
        keys.push(it.key!);
      }
      expect(keys).toEqual(['OL2M', 'OL3M']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SeekError when resuming mid-gz fails', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}']);
    try {
      const iter = new DumpStreamer(path).iter({ startByteOffset: 4, lastKeyCursor: null, keyOf });
      await expect(iter.next()).rejects.toThrow(SeekError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
