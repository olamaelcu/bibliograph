/**
 * The librarian tree's gate.
 *
 * A disabled deployment answers 404 from here, before any page below it runs, and
 * a signed-out visitor is sent to the sign-in page instead of being shown an
 * empty queue.
 */

import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

import { librarianConfig } from '$lib/server/librarian/config';
import { librarianDid } from '$lib/server/librarian/session';
import { canonicalDevUrl } from '$lib/server/librarian/return-to';

export const load: LayoutServerLoad = ({ cookies, url }) => {
  const config = librarianConfig();
  if (!config.enabled) error(404, 'Not Found');

  // Only the loopback IP is a legal redirect host, and the session cookie is
  // host-scoped: a browser on `localhost` is moved to `127.0.0.1` before any
  // state exists, so the callback and the cookie agree on the host.
  const canonical = canonicalDevUrl(url);
  if (canonical) redirect(303, canonical.toString(), { external: true });

  // The sign-in and callback routes live under this layout but must not require
  // the cookie they are creating.
  if (url.pathname.startsWith('/librarian/login') || url.pathname.startsWith('/librarian/oauth')) {
    return { did: null };
  }

  const did = librarianDid(cookies);
  if (did === null) {
    redirect(303, `/librarian/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }
  if (!config.allowlist.has(did)) error(403, 'Forbidden');
  return { did };
};
