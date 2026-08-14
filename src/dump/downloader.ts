import { createWriteStream } from 'node:fs';
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
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': this.userAgent },
          signal: controller.signal,
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) throw new Error('redirect without Location header');
          currentUrl = new URL(location, currentUrl).toString();
          arm();
          continue;
        }
        if (!res.ok) throw new Error(`GET failed: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('response has no body');

        // Convert the web ReadableStream to a Node stream so the pipeline's
        // AbortSignal actually destroys it (pipeline does not propagate abort
        // to a web stream source). Each chunk re-arms the idle timer.
        const nodeBody = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
        nodeBody.on('data', arm);
        await pipeline(nodeBody, createWriteStream(destPath), { signal: controller.signal });
        return {
          url: res.url,
          lastModified: res.headers.get('last-modified'),
          contentLength: this.parseContentLength(res.headers.get('content-length')),
        };
      }
      throw new Error(`too many redirects (${this.maxRedirects})`);
    } catch (err) {
      try {
        await unlink(destPath);
      } catch (cleanupErr) {
        if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err: (cleanupErr as Error).message, destPath }, 'failed to remove partial download');
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
}
