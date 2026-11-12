import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_MAX_AGE,
  ADMIN_COOKIE_PATH,
  adminEnabled,
  adminToken,
  isAdminAuthenticated,
  tokensMatch
} from '$lib/server/admin/auth';

export const load: PageServerLoad = ({ cookies }) => {
  if (!adminEnabled()) error(404, 'Not Found');
  if (isAdminAuthenticated(cookies)) redirect(303, '/admin');
  return {};
};

export const actions: Actions = {
  default: async ({ cookies, request }) => {
    if (!adminEnabled()) error(404, 'Not Found');
    const expected = adminToken() as string;
    const form = await request.formData();
    const supplied = form.get('token');
    if (typeof supplied !== 'string' || !tokensMatch(supplied, expected)) {
      return fail(401, { error: 'That token is not valid.' });
    }

    cookies.set(ADMIN_COOKIE, expected, {
      path: ADMIN_COOKIE_PATH,
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ADMIN_COOKIE_MAX_AGE
    });
    redirect(303, '/admin');
  }
};
