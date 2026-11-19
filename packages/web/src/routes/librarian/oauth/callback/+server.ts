/**
 * The OAuth callback: exchange the code, then allowlist the DID.
 *
 * A sign-in by an account that is not on the list is refused here rather than
 * redirected to the queue — the person needs to know which DID they signed in as,
 * because that is the value an operator adds.
 */

import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { librarianConfig } from '$lib/server/librarian/config';
import { setLibrarianCookie } from '$lib/server/librarian/session';
import { librarianOAuthClient } from '$lib/server/librarian/oauth';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const config = librarianConfig();
  if (!config.enabled) error(404, 'Not Found');

  let did: string;
  try {
    const { session } = await librarianOAuthClient(url.origin).callback(url.searchParams);
    did = session.did;
  } catch (cause) {
    console.error('[librarian] oauth callback failed', cause);
    error(502, 'The ATProto sign-in could not be completed. Try again.');
  }

  if (!config.allowlist.has(did)) {
    error(403, `${did} is not a librarian account on this host.`);
  }

  setLibrarianCookie(cookies, did, url.protocol === 'https:');
  redirect(303, '/librarian/claims');
};
