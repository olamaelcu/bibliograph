import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpDownloader } from './downloader.js';

let dir: string;
let destPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dump-downloader-'));
  destPath = join(dir, 'dump.txt.gz');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function readStreamFromBuffer(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}

describe('HttpDownloader.headMetadata', () => {
  it('returns lastModified and contentLength from a HEAD response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({
        'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        'content-length': '9200000000',
      }),
    })) as unknown as typeof fetch);
    const dl = new HttpDownloader('https://openlibrary.org/data/ol_dump_editions_latest.txt.gz');
    const meta = await dl.headMetadata();
    expect(meta.lastModified).toBe('Wed, 01 Jan 2026 00:00:00 GMT');
    expect(meta.contentLength).toBe(9_200_000_000);
  });

  it('throws when HEAD returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch);
    const dl = new HttpDownloader('https://x');
    await expect(dl.headMetadata()).rejects.toThrow(/HEAD failed.*503/);
  });
});

describe('HttpDownloader.download', () => {
  it('streams the response body to disk and returns metadata', async () => {
    const body = Buffer.from('hello');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({
        'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        'content-length': String(body.length),
      }),
      body: readStreamFromBuffer(body),
    })) as unknown as typeof fetch);

    const dl = new HttpDownloader('https://openlibrary.org/data/ol_dump_editions_latest.txt.gz');
    const result = await dl.download(destPath);
    expect(result.lastModified).toBe('Wed, 01 Jan 2026 00:00:00 GMT');
    expect(result.contentLength).toBe(body.length);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath).toString()).toBe('hello');
    expect(statSync(destPath).size).toBe(body.length);
  });

  it('follows redirects to the new URL', async () => {
    const body = Buffer.from('redirected-body');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 302,
          headers: new Headers({ location: 'https://cdn.example/dump.txt.gz' }),
        };
      }
      expect(url).toBe('https://cdn.example/dump.txt.gz');
      return {
        ok: true,
        headers: new Headers({ 'content-length': String(body.length) }),
        body: readStreamFromBuffer(body),
      };
    }) as unknown as typeof fetch);

    const dl = new HttpDownloader('https://openlibrary.org/data/ol_dump_editions_latest.txt.gz', {
      maxRedirects: 5,
    });
    const result = await dl.download(destPath);
    expect(calls).toBe(2);
    expect(result.contentLength).toBe(body.length);
    expect(readFileSync(destPath).toString()).toBe('redirected-body');
  });

  it('throws when GET returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch);
    const dl = new HttpDownloader('https://x');
    await expect(dl.download(destPath)).rejects.toThrow(/GET failed.*503/);
  });
});
