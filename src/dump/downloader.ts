import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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
    return this.opts.timeoutMs ?? 60_000;
  }

  async downloadWithRetry(destPath: string, attempts = 2): Promise<DownloadMetadata> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.download(destPath);
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
    let currentUrl = this._url;
    for (let i = 0; i < this.maxRedirects; i += 1) {
      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('redirect without Location header');
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) throw new Error(`GET failed: ${res.status} ${res.statusText}`);

      await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(destPath));
      return {
        url: res.url,
        lastModified: res.headers.get('last-modified'),
        contentLength: this.parseContentLength(res.headers.get('content-length')),
      };
    }
    throw new Error(`too many redirects (${this.maxRedirects})`);
  }

  private parseContentLength(v: string | null): number | null {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
