import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { beginLogin, LOGIN_COOKIE, LOGIN_COOKIE_OPTIONS } from '../../lib/server/oauth/flow';

/**
 * `GET /login[?handle=<handle>]` — start the atproto OAuth flow.
 *
 * The `state` is mirrored into a short-lived cookie so the callback can tell
 * that this browser started the login it is finishing (login CSRF: without it,
 * a victim following an attacker's callback URL would be signed into the
 * attacker's account). It is `SameSite=Lax`, so the PDS's top-level redirect
 * back to us still carries it.
 */
const handle: RequestHandler = async ({ url, cookies }) => {
  const requested = url.searchParams.get('handle')?.trim();
  const { authorizeUrl, state } = await beginLogin(url.origin, requested || undefined);

  cookies.set(LOGIN_COOKIE, state, LOGIN_COOKIE_OPTIONS);
  // The authorization server is another origin by design.
  redirect(303, authorizeUrl, { external: true });
};

export const GET: RequestHandler = handle;
