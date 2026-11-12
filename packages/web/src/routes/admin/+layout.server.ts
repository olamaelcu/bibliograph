import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { adminEnabled, isAdminAuthenticated } from '$lib/server/admin/auth';

export const load: LayoutServerLoad = ({ cookies, url }) => {
  if (!adminEnabled()) error(404, 'Not Found');

  const authenticated = isAdminAuthenticated(cookies);
  if (url.pathname !== '/admin/login' && !authenticated) {
    redirect(303, '/admin/login');
  }
  return { authenticated };
};
