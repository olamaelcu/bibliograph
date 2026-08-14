import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpDownloader } from './downloader.js';

describe('HttpDownloader', () => {
  it('follows redirects and writes body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-downloader-'));
    try {
      const downloader = new HttpDownloader('https://example.test/dump.gz', { maxRedirects: 3 });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response('', {
          status: 302,
          headers: { location: 'https://archive.example/dump.gz' },
        }))
        .mockResolvedValueOnce(new Response('hello', {
          status: 200,
          headers: { 'content-length': '5' },
        }));

      vi.stubGlobal('fetch', mockFetch);

      const meta = await downloader.download(join(dir, 'out.gz'));
      expect(meta.contentLength).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on non-2xx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-downloader-'));
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
      const downloader = new HttpDownloader('https://example.test/x');
      await expect(downloader.download(join(dir, 'x'))).rejects.toThrow(/500/);
      vi.unstubAllGlobals();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
