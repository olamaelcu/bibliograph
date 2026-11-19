/**
 * Librarian access control.
 *
 * A librarian is a real ATProto account, not a shared password: the queue at
 * `/librarian` is reachable only by a DID in `LIBRARIAN_DIDS`, and the DID that
 * signed in is what every decision is recorded against (`issuedBy`).
 *
 * Both `LIBRARIAN_DIDS` and `LIBRARIAN_SESSION_SECRET` must be set for the
 * feature to exist at all. Anything less and the whole tree answers 404, exactly
 * like `/admin` without `ADMIN_TOKEN`, so a half-configured host cannot expose a
 * queue nobody is allowed to decide.
 */

import { env } from '$env/dynamic/private';

import { parseAllowlist } from './cookie.ts';

export type LibrarianConfig = {
  enabled: boolean;
  allowlist: ReadonlySet<string>;
  secret: string;
};

export function librarianConfig(): LibrarianConfig {
  const allowlist = parseAllowlist(env.LIBRARIAN_DIDS);
  const secret = (env.LIBRARIAN_SESSION_SECRET ?? '').trim();
  return { enabled: allowlist.size > 0 && secret !== '', allowlist, secret };
}

/**
 * True when an origin is plain HTTP, which only local development is.
 *
 * The OAuth client refuses an insecure authorization server by default, and a
 * development host speaks HTTP end to end (edge, PDS, PLC); production is https,
 * so the exception is scoped to the origin rather than to a build mode.
 */
export function isInsecureOrigin(origin: string): boolean {
  return new URL(origin).protocol === 'http:';
}
