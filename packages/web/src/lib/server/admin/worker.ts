import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { adminToken } from './auth';

const DEFAULT_WORKER_ADMIN_URL = 'http://127.0.0.1:9465';
const TIMEOUT_MS = 20_000;

/** Worker admin routes the edge proxies; anything else is a programming error. */
export type AdminWorkerPath =
  | '/provider-search'
  | '/contributor-search'
  | '/resolve-format'
  | '/ingest'
  | '/publisher-search'
  | '/publisher-books'
  | '/publisher-import';

export function workerAdminUrl(): string {
  const configured = env.WORKER_ADMIN_URL?.trim();
  return (configured || DEFAULT_WORKER_ADMIN_URL).replace(/\/+$/, '');
}

/**
 * Proxy an admin POST to the worker over loopback. The operator token is added
 * here and never returned; the browser only ever talks to this origin.
 */
export async function workerAdminPost(
  path: AdminWorkerPath,
  body: unknown,
  { timeoutMs = TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<{ status: number; payload: unknown }> {
  const token = adminToken();
  if (!token) error(404, 'Not Found');

  let response: Response;
  try {
    response = await fetch(`${workerAdminUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    console.error(`[admin] worker admin request to ${path} failed`, cause);
    error(502, 'The worker admin API is unavailable');
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON upstream answer is still a failure, not a crash.
  }
  return { status: response.status, payload };
}
