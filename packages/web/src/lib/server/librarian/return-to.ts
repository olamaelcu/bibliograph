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
