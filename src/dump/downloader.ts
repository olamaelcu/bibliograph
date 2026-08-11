import { createWriteStream } from 'node:fs';
import { logger } from '../logger.js';

export interface DownloadMetadata {
  url: string;
  lastModified: string | null;
  contentLength: number | null;
}

export interface DownloaderOptions {
  maxRedirects?: number;
  userAgent?: string;
}

const DEFAULT_USER_AGENT = 'bibliograph/0.1.0 (+https://github.com/olamaelcu/bibliograph)';

export class HttpDownloader {
  constructor(
    private readonly _url: string,
    private readonly opts: DownloaderOptions = {},
  ) { }

  get url(): string {
    return this._url;
  }

  private get userAgent(): string {
    return this.opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  private get maxRedirects(): number {
    return this.opts.maxRedirects ?? 5;
  }

  async downloadWithRetry(destPath: string): Promise<DownloadMetadata> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.download(destPath);
      } catch (err) {
        lastErr = err;
        logger.warn(
          { url: this._url, attempt: attempt + 1, err: (err as Error).message },
          'dump download failed; retrying once',
        );
      }
    }
    throw lastErr;
  }

  async headMetadata(currentUrl: string = this.url): Promise<DownloadMetadata> {
    const res = await fetch(currentUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': this.userAgent },
    });
    if (!res.ok) {
      throw new Error(`HEAD failed for ${currentUrl}: ${res.status} ${res.statusText}`);
    }
    return {
      url: res.url,
      lastModified: res.headers.get('last-modified'),
      contentLength: this.parseContentLength(res.headers.get('content-length')),
    };
  }

  async download(destPath: string): Promise<DownloadMetadata> {
    let currentUrl = this.url;
    for (let i = 0; i < this.maxRedirects; i += 1) {
      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': this.userAgent },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`redirect without Location header`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new Error(`GET failed for ${currentUrl}: ${res.status} ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error(`GET ${currentUrl}: no response body`);
      }

      const lastModified = res.headers.get('last-modified');
      const contentLength = this.parseContentLength(res.headers.get('content-length'));
      const writer = createWriteStream(destPath);
      try {
        await res.body.pipeTo(this.toWritable(writer));
      } finally {
        await new Promise<void>(r => writer.end(() => r()));
      }

      return { url: currentUrl, lastModified, contentLength };
    }
    throw new Error(`too many redirects (max ${this.maxRedirects}) from ${this.url}`);
  }

  private parseContentLength(s: string | null): number | null {
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  private toWritable(nodeStream: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await new Promise<void>((resolve, reject) => {
          const ok = (nodeStream as any).write(chunk, (err?: Error) => {
            if (err) reject(err);
            else resolve();
          });
          if (!ok) {
            (nodeStream as any).once('drain', () => resolve());
          }
        });
      },
    });
  }
}
