import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  destroyWebSession,
  readWebSession,
} from '$lib/server/auth/session';
import { forgetOAuthSession } from '$lib/server/auth/oauth';

export const POST: RequestHandler = async ({ cookies }) => {
  const sessionId = cookies.get(SESSION_COOKIE);
  if (sessionId) {
    const viewer = await readWebSession(sessionId);
    await destroyWebSession(sessionId);
    if (viewer) await forgetOAuthSession(viewer.did);
  }
  clearSessionCookie(cookies);
  redirect(303, '/');
};
