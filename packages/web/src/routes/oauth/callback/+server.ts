import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  completeLogin,
  LOGIN_COOKIE,
  startSessionCookie
} from '../../../lib/server/oauth/flow';

/**
 * `GET /oauth/callback?code=…&state=…` — finish the flow and set the session.
 *
 * The session id goes into an HttpOnly cookie; the DPoP key and the tokens stay
 * on the server, in the store `lib/server/oauth/store.ts` documents.
 */
const handle: RequestHandler = async ({ url, cookies }) => {
  const error = url.searchParams.get('error');
  if (error) {
    return json(
      { error, description: url.searchParams.get('error_description') ?? '' },
      { status: 400 }
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const bound = cookies.get(LOGIN_COOKIE);
  cookies.delete(LOGIN_COOKIE, { path: '/' });

  if (!code || !state || !bound || state !== bound) {
    return json({ error: 'InvalidRequest', description: 'missing or mismatched state' }, { status: 400 });
  }

  try {
    const session = await completeLogin({ code, state });
    startSessionCookie(cookies, session);
  } catch (cause) {
    return json(
      { error: 'LoginFailed', description: cause instanceof Error ? cause.message : String(cause) },
      { status: 400 }
    );
  }

  redirect(303, '/');
};

export const GET: RequestHandler = handle;
