import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DumpStreamer, SeekError } from './streamer.js';

function fixture(lines: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dump-streamer-'));
  const path = join(dir, 'fixture.txt.gz');
  writeFileSync(path, gzipSync(lines.join('\n') + '\n'));
  return { dir, path };
}

const keyOf = (f: string[]) => f[1] ?? null;

describe('DumpStreamer', () => {
  it('yields all lines with byte offsets', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}', 'c\tOL3M\t0\tx\t{}']);
    try {
      const items: Array<{ offset: number; key: string }> = [];
      for await (const it of new DumpStreamer(path).iter({ startByteOffset: 0, lastKeyCursor: null, keyOf })) {
        items.push({ offset: it.byteOffset, key: it.fields[1] });
      }
      expect(items.map((i) => i.key)).toEqual(['OL1M', 'OL2M', 'OL3M']);
      expect(items[0].offset).toBe(0);
      expect(items[1].offset).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips lines with key <= lastKeyCursor', async () => {
    const { dir, path } = fixture(['a\tOL1M\t0\tx\t{}', 'b\tOL2M\t0\tx\t{}', 'c\tOL3M\t0\tx\t{}']);
    try {
      const keys: string[] = [];
      for await (const it of new DumpStreamer(path).iter({ startByteOffset: 0, lastKeyCursor: 'OL2M', keyOf })) {
        keys.push(it.fields[1]);
      }
      expect(keys).toEqual(['OL3M']);
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
