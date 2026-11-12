import { redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { ADMIN_COOKIE, ADMIN_COOKIE_PATH } from '$lib/server/admin/auth';

export const actions: Actions = {
  logout: ({ cookies }) => {
    cookies.delete(ADMIN_COOKIE, { path: ADMIN_COOKIE_PATH });
    redirect(303, '/admin/login');
  }
};
