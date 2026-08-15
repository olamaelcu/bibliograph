import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { countDumpLines, readCountCache, writeCountCache } from './count-lines.js';

function fixture(lines: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'count-lines-'));
  const path = join(dir, 'fixture.txt.gz');
  writeFileSync(path, gzipSync(lines.join('\n') + '\n'));
  return { dir, path };
}

describe('countDumpLines', () => {
  it('counts every line with >= 5 fields', async () => {
    const { dir, path } = fixture([
      '/type/edition\t/books/OL1M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL1M"}',
      '/type/edition\t/books/OL2M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL2M"}',
      '/type/edition\t/books/OL3M\t1\t2026-01-01T00:00:00Z\t{"key":"/books/OL3M"}',
    ]);
    try {
      expect(await countDumpLines(path)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips short/malformed lines so the count matches what import processes', async () => {
    const { dir, path } = fixture(['a\tb\tc', '/type/edition\t/books/OL1M\t1\t2026-01-01T00:00:00Z\t{}']);
    try {
      expect(await countDumpLines(path)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('count cache', () => {
  it('round-trips a count and reuses it while the file is unchanged', async () => {
    const { dir, path } = fixture(['a\tb\tc\td\te']);
    try {
      expect(readCountCache(path)).toBeNull();
      writeCountCache(path, 42);
      expect(readCountCache(path)).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidates the cache when the dump file changes', async () => {
    const { dir, path } = fixture(['a\tb\tc\td\te']);
    try {
      writeCountCache(path, 1);
      // Rewrite with different content (different size) so size+mtime no longer match.
      writeFileSync(path, gzipSync('x\ty\tz\tw\tv\n1\n2\n'));
      expect(readCountCache(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
