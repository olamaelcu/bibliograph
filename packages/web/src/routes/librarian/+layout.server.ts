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

export const load: LayoutServerLoad = ({ cookies, url }) => {
  const config = librarianConfig();
  if (!config.enabled) error(404, 'Not Found');

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
