import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endSession } from '../../lib/server/oauth/flow';

/**
 * `POST /logout` — revoke the session and forget it.
 *
 * POST, not GET: a plain link would let any page sign the user out. The cookie
 * is cleared before the upstream revocation, so an unreachable HappyView still
 * leaves the browser signed out — the session's tokens are HappyView's problem
 * at that point, and it revokes them at the PDS when it next runs.
 */
const handle: RequestHandler = async ({ cookies }) => {
  try {
    await endSession(cookies);
  } catch (cause) {
    console.error('logout: revoking the upstream session failed', cause);
  }
  redirect(303, '/');
};

export const POST: RequestHandler = handle;
