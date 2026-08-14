import { createWriteStream } from 'node:fs';
import { statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { logger } from '../logger.js';

export interface DownloadMetadata {
  url: string;
  lastModified: string | null;
  contentLength: number | null;
}

export interface DownloaderOptions {
  maxRedirects?: number;
  userAgent?: string;
  timeoutMs?: number;
  /** Called as body bytes stream in; total is null when the server sends no content-length. */
  onProgress?: (received: number, total: number | null) => void;
}

const DEFAULT_USER_AGENT = 'bibliograph/0.1.0 (+https://github.com/olamaelcu/bibliograph)';

export class HttpDownloader {
  constructor(
    private readonly _url: string,
    private readonly opts: DownloaderOptions = {},
  ) {}

  get url(): string {
    return this._url;
  }

  private get userAgent(): string {
    return this.opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  private get maxRedirects(): number {
    return this.opts.maxRedirects ?? 5;
  }

  private get timeoutMs(): number {
    if (this.opts.timeoutMs != null) return this.opts.timeoutMs;
    const env = Number(process.env.DUMP_DOWNLOAD_TIMEOUT_MS);
    return Number.isFinite(env) && env > 0 ? env : 60_000;
  }

  async downloadWithRetry(destPath: string, attempts = 2): Promise<DownloadMetadata> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const meta = await this.download(destPath);
        logger.info(
          {
            url: this._url,
            destPath,
            bytes: meta.contentLength,
            sizeMb: meta.contentLength ? (meta.contentLength / 1024 / 1024).toFixed(1) : null,
          },
          'dump download complete',
        );
        return meta;
      } catch (err) {
        lastErr = err;
        logger.warn({ url: this._url, attempt: attempt + 1, err: (err as Error).message }, 'dump download failed; retrying');
      }
    }
    throw lastErr;
  }

  async headMetadata(): Promise<DownloadMetadata> {
    const res = await fetch(this._url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HEAD failed: ${res.status} ${res.statusText}`);
    return {
      url: res.url,
      lastModified: res.headers.get('last-modified'),
      contentLength: this.parseContentLength(res.headers.get('content-length')),
    };
  }

  async download(destPath: string): Promise<DownloadMetadata> {
    // Resumable download: a partially-downloaded file on disk is resumed via
    // an HTTP Range request instead of re-downloading from byte 0.
    let existingSize = 0;
    try {
      existingSize = statSync(destPath).size;
    } catch {
      existingSize = 0; // missing file = fresh download
    }

    // Idle timeout: aborts only when no data arrives for `timeoutMs`, so a
    // slow-but-flowing multi-GB download is never killed by a wall-clock cap.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    arm();
    try {
      let currentUrl = this._url;
      for (let i = 0; i < this.maxRedirects; i += 1) {
        const headers: Record<string, string> = { 'User-Agent': this.userAgent };
        if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`;
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers,
          signal: controller.signal,
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) throw new Error('redirect without Location header');
          currentUrl = new URL(location, currentUrl).toString();
          arm();
          continue;
        }

        // 416 Range Not Satisfiable: the server thinks we're already at/over
        // the total, so the partial is effectively complete — reuse it.
        if (res.status === 416) {
          const total = this.parseContentRangeTotal(res.headers.get('content-range'));
          return {
            url: res.url,
            lastModified: res.headers.get('last-modified'),
            contentLength: total ?? existingSize,
          };
        }
        if (!res.ok) throw new Error(`GET failed: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('response has no body');

        const isResume = res.status === 206;
        // Authoritative final size: for 206 it's the Content-Range total;
        // for 200 it's the full Content-Length. If neither header is present,
        // fall back to the partial size plus the incoming body length.
        const contentLength = this.parseContentLength(res.headers.get('content-length'));
        const totalSize =
          (isResume
            ? this.parseContentRangeTotal(res.headers.get('content-range'))
            : contentLength) ??
          (contentLength !== null ? existingSize + contentLength : null);

        // Convert the web ReadableStream to a Node stream so the pipeline's
        // AbortSignal actually destroys it (pipeline does not propagate abort
        // to a web stream source). Each chunk re-arms the idle timer and
        // reports progress (absolute bytes, including what we resumed over).
        const nodeBody = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
        let received = existingSize;
        nodeBody.on('data', (chunk: Buffer) => {
          arm();
          received += chunk.length;
          this.opts.onProgress?.(received, totalSize);
        });
        // Append when resuming, truncate on a fresh (200) start.
        await pipeline(nodeBody, createWriteStream(destPath, { flags: isResume ? 'a' : 'w' }), {
          signal: controller.signal,
        });
        return {
          url: res.url,
          lastModified: res.headers.get('last-modified'),
          contentLength: totalSize,
        };
      }
      throw new Error(`too many redirects (${this.maxRedirects})`);
    } catch (err) {
      // Keep the partial file: a later run resumes it via Range instead of
      // re-downloading. Remove it only if the server gave a clean error for
      // a fresh (non-resumed) download.
      if (existingSize === 0) {
        try {
          await unlink(destPath);
        } catch (cleanupErr) {
          if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({ err: (cleanupErr as Error).message, destPath }, 'failed to remove partial download');
          }
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseContentLength(v: string | null): number | null {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Parse the total from a Content-Range header, e.g. "bytes 0-99/500" -> 500. */
  private parseContentRangeTotal(v: string | null): number | null {
    if (!v) return null;
    const total = v.split('/')[1];
    if (total === undefined || total === '*') return null;
    const n = Number(total);
    return Number.isFinite(n) ? n : null;
  }
}
