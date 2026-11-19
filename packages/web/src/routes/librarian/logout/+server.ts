/**
 * Sign-out: clear the cookie and revoke the stored token set.
 *
 * POST only, so a link in a page cannot sign a librarian out.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { librarianConfig } from '$lib/server/librarian/config';
import { clearLibrarianCookie, librarianDid } from '$lib/server/librarian/session';
import { librarianOAuthClient } from '$lib/server/librarian/oauth';

export const POST: RequestHandler = async ({ url, cookies }) => {
  if (!librarianConfig().enabled) throw redirect(303, '/');

  const did = librarianDid(cookies);
  clearLibrarianCookie(cookies);
  if (did !== null) {
    // A revocation failure must not keep the cookie alive; it only leaves a
    // token set in the table, which the next sign-in overwrites.
    try {
      await librarianOAuthClient(url.origin).revoke(did);
    } catch (error) {
      console.error(`[librarian] revoke failed for ${did}`, error);
    }
  }
  redirect(303, '/librarian/login');
};
