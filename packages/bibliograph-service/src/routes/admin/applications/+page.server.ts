import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  approveApplication,
  isAdmin,
  listApplications,
  rejectApplication,
  revokeLibrarian,
} from '$lib/server/labeler/librarian';
import { log } from '$lib/server/xrpc-router';

/** Only admins (ADMIN_DIDS) may see or act on the queue. */
function requireAdmin(did: string | undefined): string {
  if (!did) redirect(303, '/login?next=/admin/applications');
  if (!isAdmin(did)) error(403, 'This account is not a librarian admin.');
  return did;
}

export const load: PageServerLoad = async ({ locals }) => {
  requireAdmin(locals.viewer?.did);
  const [pending, decided] = await Promise.all([
    listApplications('pending'),
    listApplications('all'),
  ]);
  return {
    pending,
    decided: decided.filter((row) => row.status !== 'pending'),
  };
};

async function act(
  event: Parameters<NonNullable<Actions['approve']>>[0],
  run: (did: string, adminDid: string) => Promise<unknown>,
) {
  const adminDid = requireAdmin(event.locals.viewer?.did);
  const form = await event.request.formData();
  const did = String(form.get('did') ?? '').trim();
  if (!did.startsWith('did:')) return fail(400, { error: 'Expected a DID' });
  try {
    await run(did, adminDid);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, did, adminDid }, 'librarian admin action failed');
    return fail(502, { error: message });
  }
}

export const actions: Actions = {
  approve: (event) => act(event, (did, admin) => approveApplication(did, admin)),
  reject: (event) => act(event, (did, admin) => rejectApplication(did, admin)),
  revoke: (event) => act(event, (did, admin) => revokeLibrarian(did, admin)),
};
