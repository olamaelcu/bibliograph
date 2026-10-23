import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createWebSession, setSessionCookie } from '$lib/server/auth/session';
import { getOAuthClient } from '$lib/server/auth/oauth';
import { actorHandle } from '$lib/server/pds/resolve';
import { LOGIN_NEXT_COOKIE, safeNextPath } from '../../login/next-path';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const client = await getOAuthClient();

  let did: string;
  try {
    const { session } = await client.callback(url.searchParams);
    did = session.did;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    redirect(303, `/login?error=${encodeURIComponent(`Sign-in failed: ${message}`)}`);
  }

  const handle = await actorHandle(did);
  const { id, expiresAt } = await createWebSession(did, handle);
  setSessionCookie(cookies, id, expiresAt, url.protocol === 'https:');

  const next = safeNextPath(cookies.get(LOGIN_NEXT_COOKIE));
  cookies.delete(LOGIN_NEXT_COOKIE, { path: '/' });
  redirect(303, next);
};
