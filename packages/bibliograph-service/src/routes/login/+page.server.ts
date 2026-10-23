import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getOAuthClient, OAUTH_SCOPE } from '$lib/server/auth/oauth';
import { LOGIN_NEXT_COOKIE, safeNextPath } from './next-path';

const COOKIE_OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 600 };

export const load: PageServerLoad = async ({ url, locals }) => {
  const next = safeNextPath(url.searchParams.get('next'));
  if (locals.viewer) redirect(303, next);
  return {
    next,
    error: url.searchParams.get('error'),
  };
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '').trim();
    const next = safeNextPath(String(form.get('next') ?? ''));

    if (!handle) {
      return fail(400, { handle, next, error: 'Enter your handle, e.g. you.bsky.social or alice.example.com' });
    }

    let authUrl: URL;
    try {
      const client = await getOAuthClient();
      authUrl = await client.authorize(handle, { scope: OAUTH_SCOPE });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(400, {
        handle,
        next,
        error: `Could not start sign-in for "${handle}": ${message}`,
      });
    }

    cookies.set(LOGIN_NEXT_COOKIE, next, { ...COOKIE_OPTS, secure: url.protocol === 'https:' });
    redirect(303, authUrl.toString());
  },
};
