import { createHash, timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';

/**
 * The operator token is only ever read server-side. `ADMIN_TOKEN` unset means
 * the whole /admin area and every /admin/api route answer 404, exactly as if
 * the feature did not exist.
 */
export const ADMIN_COOKIE = 'bib_admin';
export const ADMIN_COOKIE_PATH = '/admin';
export const ADMIN_COOKIE_MAX_AGE = 12 * 60 * 60;

export function adminToken(): string | undefined {
  const value = env.ADMIN_TOKEN?.trim();
  return value ? value : undefined;
}

export function adminEnabled(): boolean {
  return adminToken() !== undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of two arbitrary-length strings. */
export function tokensMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function isAdminAuthenticated(cookies: Cookies): boolean {
  const expected = adminToken();
  if (!expected) return false;
  const supplied = cookies.get(ADMIN_COOKIE);
  if (typeof supplied !== 'string' || supplied === '') return false;
  return tokensMatch(supplied, expected);
}

/**
 * Guard for server routes. Throws a 404 when the feature is disabled and 401
 * when the cookie is missing or wrong; SvelteKit turns both into a JSON error
 * response for `+server.ts` routes.
 */
export function requireAdmin(cookies: Cookies): void {
  if (!adminEnabled()) error(404, 'Not Found');
  if (!isAdminAuthenticated(cookies)) error(401, 'Unauthorized');
}
