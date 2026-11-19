/**
 * The librarian session cookie, and the guard the librarian routes use.
 *
 * A signed cookie rather than a server-side session table: the OAuth token set is
 * already stored per DID by the client (see `stores.ts`), so the only thing the
 * browser needs to carry is *which* librarian it is. The HMAC is what stops a
 * browser from claiming someone else's DID. Twelve hours, like the operator
 * cookie: long enough for a review session, short enough that a forgotten browser
 * at a shared machine stops being useful.
 *
 * The codec itself lives in `cookie.ts`, so it can be tested without a SvelteKit
 * environment.
 */

import { error, type Cookies } from '@sveltejs/kit';

import { librarianConfig } from './config.ts';
import {
  LIBRARIAN_COOKIE_MAX_AGE,
  readSessionCookie,
  signSessionCookie
} from './cookie.ts';

export const LIBRARIAN_COOKIE = 'bib_librarian';
export const LIBRARIAN_COOKIE_PATH = '/librarian';

/** The DID a cookie vouches for, or null when it is absent, stale or forged. */
export function librarianDid(cookies: Cookies): string | null {
  const config = librarianConfig();
  if (!config.enabled) return null;
  return readSessionCookie(
    cookies.get(LIBRARIAN_COOKIE),
    config.secret,
    Math.floor(Date.now() / 1000)
  );
}

export function setLibrarianCookie(cookies: Cookies, did: string, secure: boolean): void {
  const { secret } = librarianConfig();
  const expires = Math.floor(Date.now() / 1000) + LIBRARIAN_COOKIE_MAX_AGE;
  cookies.set(LIBRARIAN_COOKIE, signSessionCookie(did, expires, secret), {
    path: LIBRARIAN_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: LIBRARIAN_COOKIE_MAX_AGE
  });
}

export function clearLibrarianCookie(cookies: Cookies): void {
  cookies.delete(LIBRARIAN_COOKIE, { path: LIBRARIAN_COOKIE_PATH });
}

/**
 * Guard for the librarian routes: 404 when the feature is off, 401 when the
 * cookie is missing or stale, 403 for a DID that is no longer allowlisted.
 */
export function requireLibrarian(cookies: Cookies): string {
  const config = librarianConfig();
  if (!config.enabled) error(404, 'Not Found');
  const did = librarianDid(cookies);
  if (did === null) error(401, 'Unauthorized');
  if (!config.allowlist.has(did)) error(403, 'Forbidden');
  return did;
}
