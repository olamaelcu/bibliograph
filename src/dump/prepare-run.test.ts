import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../test-utils/db.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { prepareRun } from './index.js';

let dir: string;
let gzPath: string;
let db: ReturnType<typeof createTestDb>['db'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prepare-run-'));
  gzPath = join(dir, 'dump.txt.gz');
  db = createTestDb().db;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function makeDownloader(body: string, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      'content-length': String(body.length),
      'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
      ...headers,
    }),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
  })));
  return new HttpDownloader('https://x');
}

describe('prepareRun', () => {
  it('writes the body to gzPath via a temp file then renames atomically', async () => {
    const downloader = makeDownloader('payload');
    const state = new DumpState(db, 'prepare_run');
    const result = await prepareRun({
      downloader, state, gzPath, url: 'https://x', noDownload: false,
    });
    expect(readFileSync(gzPath).toString()).toBe('payload');
    expect(existsSync(`${gzPath}.part`)).toBe(false);
    expect(result.fileSize).toBe('payload'.length);
  });

  it('refuses to commit when content-length mismatches', async () => {
    const downloader = makeDownloader('short', { 'content-length': '999' });
    const state = new DumpState(db, 'prepare_run');
    await expect(prepareRun({
      downloader, state, gzPath, url: 'https://x', noDownload: false,
    })).rejects.toThrow(/size mismatch/);
    expect(existsSync(gzPath)).toBe(false);
    expect(existsSync(`${gzPath}.part`)).toBe(false);
  });

  it('short-circuits without rewriting state when local file is current and prior run is complete', async () => {
    const body = 'cached-body';
    writeFileSync(gzPath, body);
    const state = new DumpState(db, 'prepare_run');
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: body.length,
      lastByteOffset: body.length,
      lastKeyCursor: '/books/OL1M',
      lastNumericCursor: 1,
      totalProcessed: 42,
      complete: true,
    });
    const downloader = makeDownloader('not-used');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (downloader as any).headMetadata = vi.fn(async () => ({
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      contentLength: body.length,
    }));

    const result = await prepareRun({
      downloader, state, gzPath, url: 'https://x', noDownload: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: body.length,
    });
    expect(state.get()).toMatchObject({
      lastByteOffset: body.length,
      lastKeyCursor: '/books/OL1M',
      lastNumericCursor: 1,
      totalProcessed: 42,
      complete: true,
    });
  });

  it('returns immediately without download when prior.complete=false (resume partial)', async () => {
    const body = 'cached-body';
    writeFileSync(gzPath, body);
    const state = new DumpState(db, 'prepare_run');
    state.set({
      url: 'https://x',
      filePath: gzPath,
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      fileSize: body.length,
      lastByteOffset: body.length,
      lastKeyCursor: '/books/OL1M',
      lastNumericCursor: 1,
      totalProcessed: 21,
      complete: false,
    });
    const downloader = makeDownloader('not-used');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (downloader as any).headMetadata = vi.fn(async () => ({
      url: 'https://x',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
      contentLength: body.length,
    }));

    const result = await prepareRun({
      downloader, state, gzPath, url: 'https://x', noDownload: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.fileSize).toBe(body.length);
    expect(state.get()).toMatchObject({
      lastByteOffset: body.length,
      lastKeyCursor: '/books/OL1M',
      lastNumericCursor: 1,
      totalProcessed: 21,
      complete: false,
    });
  });
});
