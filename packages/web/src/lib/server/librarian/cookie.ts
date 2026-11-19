/**
 * The librarian allowlist and session cookie, without any configuration
 * dependence: both take their secret (or their raw value) as an argument.
 *
 * Split from `session.ts` so the two rules that matter — an allowlist entry is a
 * DID and nothing else, and a cookie is only valid while its HMAC verifies and
 * its expiry has not passed — are testable without a SvelteKit environment.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A cookie's fixed prefix: base64url(did) + '.' + expiry seconds + '.' + HMAC. */
export const LIBRARIAN_COOKIE_PARTS = 3;
export const LIBRARIAN_COOKIE_MAX_AGE = 12 * 60 * 60;

/**
 * One or more DIDs, separated by commas or whitespace. An entry that is not a
 * DID is dropped rather than kept as a value nobody could ever sign in as.
 */
export function parseAllowlist(value: string | undefined): Set<string> {
  const entries = (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('did:'));
  return new Set(entries);
}

function signature(did: string, expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`${did}.${expires}`).digest('base64url');
}

/** The cookie value for one DID, valid until `expires` (Unix seconds). */
export function signSessionCookie(did: string, expires: number, secret: string): string {
  return `${Buffer.from(did, 'utf8').toString('base64url')}.${expires}.${signature(did, expires, secret)}`;
}

/**
 * The DID a cookie value vouches for, or null when it is malformed, expired or
 * not signed with `secret`.
 *
 * The allowlist is deliberately not consulted here: an operator who removes a DID
 * should get a refusal (403), not a sign-in page, and that distinction needs the
 * two checks to stay apart.
 */
export function readSessionCookie(
  raw: unknown,
  secret: string,
  nowSeconds: number
): string | null {
  if (typeof raw !== 'string' || raw === '') return null;

  const parts = raw.split('.');
  if (parts.length !== LIBRARIAN_COOKIE_PARTS) return null;
  const [encodedDid, expiresRaw, given] = parts;
  if (encodedDid === undefined || expiresRaw === undefined || given === undefined) return null;

  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= nowSeconds) return null;

  let did: string;
  try {
    did = Buffer.from(encodedDid, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = Buffer.from(signature(did, expires, secret), 'utf8');
  const givenBytes = Buffer.from(given, 'utf8');
  if (givenBytes.length !== expected.length) return null;
  // An empty secret would otherwise make every forged cookie verify.
  if (!timingSafeEqual(givenBytes, expected)) return null;
  return did;
}
