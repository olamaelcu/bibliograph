// Post-login redirect target.
//
// Kept in its own module because both the login action and the OAuth callback
// must validate it identically: a `next` value that is not a same-origin path
// would turn the login form into an open redirect.

export const LOGIN_NEXT_COOKIE = 'bib_login_next';

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  // `//host` is off-site, and `\` is normalised to `/` by browsers, so `/\host`
  // leaves the origin too. Control characters would be smuggled into `Location`.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    return '/';
  }
  return raw;
}
