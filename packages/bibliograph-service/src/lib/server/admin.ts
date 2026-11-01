// The gate every `/admin` server route goes through.
//
// The header link is a convenience, not an authorization: a hand-typed URL must
// hit the same wall, so each route re-checks on the server. Anonymous visitors
// are sent to sign in and then back to the page they asked for.

import { error, redirect } from '@sveltejs/kit';
import { isAdministrator } from './labeler/librarian';

export async function requireAdmin(
  viewer: { did: string; handle: string | null } | null | undefined,
  next: string,
): Promise<string> {
  if (!viewer) redirect(303, `/login?next=${encodeURIComponent(next)}`);
  if (!(await isAdministrator(viewer.did))) error(403, 'This account is not an administrator.');
  return viewer.did;
}
