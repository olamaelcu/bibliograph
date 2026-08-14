import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpDownloader } from './downloader.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dump-downloader-'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpDownloader', () => {
  it('follows redirects and writes the body bytes', async () => {
    const dir = makeTempDir();
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

      const dest = join(dir, 'out.gz');
      const meta = await downloader.download(dest);
      expect(meta.contentLength).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(readFileSync(dest, 'utf8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on non-2xx', async () => {
    const dir = makeTempDir();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
      const downloader = new HttpDownloader('https://example.test/x');
      await expect(downloader.download(join(dir, 'x'))).rejects.toThrow(/500/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downloadWithRetry fails over to a successful retry', async () => {
    const dir = makeTempDir();
    try {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(new Response('ok', {
          status: 200,
          headers: { 'content-length': '2' },
        }));
      vi.stubGlobal('fetch', mockFetch);

      const downloader = new HttpDownloader('https://example.test/dump.gz', { maxRedirects: 3 });
      const dest = join(dir, 'out.gz');
      const meta = await downloader.downloadWithRetry(dest, 2);
      expect(meta.contentLength).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(readFileSync(dest, 'utf8')).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('headMetadata reads url, last-modified, content-length from a HEAD response', async () => {
    const headRes = new Response('', {
      status: 200,
      headers: { 'content-length': '12345', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
    });
    Object.defineProperty(headRes, 'url', { value: 'https://example.test/dump.gz' });
    const mockFetch = vi.fn().mockResolvedValue(headRes);
    vi.stubGlobal('fetch', mockFetch);

    const downloader = new HttpDownloader('https://example.test/dump.gz');
    const meta = await downloader.headMetadata();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.test/dump.gz',
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(meta.url).toBe('https://example.test/dump.gz');
    expect(meta.lastModified).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
    expect(meta.contentLength).toBe(12345);
  });

  it('rejects after exceeding the redirect limit', async () => {
    const dir = makeTempDir();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'https://example.test/loop.gz' } }),
      ));

      const downloader = new HttpDownloader('https://example.test/dump.gz', { maxRedirects: 2 });
      await expect(downloader.download(join(dir, 'out.gz'))).rejects.toThrow(/too many redirects/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a 302 without a Location header', async () => {
    const dir = makeTempDir();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 302 })));
      const downloader = new HttpDownloader('https://example.test/dump.gz');
      await expect(downloader.download(join(dir, 'out.gz'))).rejects.toThrow(/redirect without Location header/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative redirect Location against the current URL', async () => {
    const dir = makeTempDir();
    try {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'next.gz' } }))
        .mockResolvedValueOnce(new Response('data', { status: 200 }));
      vi.stubGlobal('fetch', mockFetch);

      const downloader = new HttpDownloader('https://example.test/a/b/dump.gz', { maxRedirects: 3 });
      await downloader.download(join(dir, 'out.gz'));
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://example.test/a/b/next.gz', expect.anything());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stalled body within the timeout and removes the partial file', async () => {
    const dir = makeTempDir();
    try {
      const neverEnding = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'));
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(neverEnding, { status: 200 })));

      const downloader = new HttpDownloader('https://example.test/dump.gz', { timeoutMs: 50 });
      const dest = join(dir, 'out.gz');
      await expect(downloader.download(dest)).rejects.toThrow(/abort/i);
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
