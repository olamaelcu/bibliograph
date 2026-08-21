import { logger } from '../logger.js';
import { NETWORK_TIMEOUT_MS } from './config.js';

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Safe JSON fetch. Returns null on any non-2xx, timeout, network error, or JSON parse error.
 * Logs a warning at warn level on failure (with URL and error message).
 */
export async function safeFetchJson<T>(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? NETWORK_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'safeFetchJson: non-2xx response');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, 'safeFetchJson: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}