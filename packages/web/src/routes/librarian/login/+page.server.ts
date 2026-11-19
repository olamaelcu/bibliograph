/**
 * Librarian sign-in: an ordinary ATProto handle, resolved to a DID, authorized
 * against this app's librarian client, and checked against the allowlist when the
 * callback returns.
 */

import { fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { librarianConfig } from '$lib/server/librarian/config';
import { librarianDid } from '$lib/server/librarian/session';
import { librarianOAuthClient } from '$lib/server/librarian/oauth';
import { internalReturnTo } from '$lib/server/librarian/return-to';

const CLAIMS = '/librarian/claims';

export const load: PageServerLoad = ({ cookies, url }) => {
  const did = librarianDid(cookies);
  if (did !== null && librarianConfig().allowlist.has(did)) {
    redirect(303, internalReturnTo(url.searchParams.get('returnTo'), CLAIMS));
  }
  return { allowlist: librarianConfig().allowlist.size };
};

export const actions: Actions = {
  default: async ({ request, url }) => {
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '').trim();
    if (handle === '') {
      return fail(400, { message: 'Enter the handle of your ATProto account.', handle: '' });
    }

    try {
      const href = await librarianOAuthClient(url.origin).authorize(handle, { scope: 'atproto' });
      // The authorization endpoint lives on the account's own PDS, so this is an
      // external redirect by design: `href` is minted by the OAuth client, never
      // from the form, and the callback returns to this origin.
      redirect(303, href.toString(), { external: true });
    } catch (error) {
      // `redirect` throws, so it must not be swallowed by this catch.
      if (isRedirect(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[librarian] authorize failed for ${handle}`, error);
      return fail(502, {
        message: `Sign-in could not start: ${message}`,
        handle
      });
    }
  }
};
