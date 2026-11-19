/**
 * Where to send a librarian after signing in.
 *
 * `returnTo` arrives in the query string, so it is attacker-controlled: only a
 * root-relative path may be honoured. Anything else (`https://…`, protocol-rel-
 * ative `//host`, or a bare value) falls back to the queue, which also keeps
 * SvelteKit's external-redirect guard from turning the page into a 500.
 */
export function internalReturnTo(value: string | null | undefined, fallback: string): string {
  const candidate = (value ?? '').trim();
  if (candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.startsWith('/\\')) {
    return candidate;
  }
  return fallback;
}

/** The loopback host RFC 8252 allows in a redirect URI; `localhost` is not. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * The librarian client's callback on `origin`.
 *
 * A development host that was opened as `localhost` still has to register a
 * loopback-IP redirect, so the host is rewritten here; the layout redirects the
 * browser to the same spelling before any state is created.
 */
export function redirectUri(origin: string): string {
  const url = new URL('/librarian/oauth/callback', origin);
  if (url.hostname === 'localhost') url.hostname = LOOPBACK_HOST;
  return url.toString();
}

/**
 * The loopback spelling of a development URL, or `null` when it is already one.
 *
 * `localhost` and `127.0.0.1` are different cookie hosts, and only the latter is
 * a legal redirect host (RFC 8252), so a browser that opens `localhost` is moved
 * before any state is created.
 */
export function canonicalDevUrl(url: URL): URL | null {
  if (url.hostname !== 'localhost') return null;
  const canonical = new URL(url);
  canonical.hostname = LOOPBACK_HOST;
  return canonical;
}
