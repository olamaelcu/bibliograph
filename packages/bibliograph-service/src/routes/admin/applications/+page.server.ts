import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';
import {
  approveApplication,
  isBootstrapAdmin,
  listApplications,
  rejectApplication,
  revokeLibrarian,
} from '$lib/server/labeler/librarian';
import { activeSubjects, clearLabel, grantLabel } from '$lib/server/labeler/labels';
import { ADMINISTRATOR_LABEL, SENIOR_LIBRARIAN_LABEL } from '$lib/server/labeler/vocabulary';
import { log } from '$lib/server/xrpc-router';

export const load: PageServerLoad = async ({ locals }) => {
  const viewerDid = await requireAdmin(locals.viewer, '/admin/applications');
  const [pending, all, administrators, seniors] = await Promise.all([
    listApplications('pending'),
    listApplications('all'),
    activeSubjects(ADMINISTRATOR_LABEL),
    activeSubjects(SENIOR_LIBRARIAN_LABEL),
  ]);
  return {
    pending,
    decided: all.filter((row) => row.status !== 'pending'),
    administrators,
    seniors,
    viewerIsBootstrapAdmin: isBootstrapAdmin(viewerDid),
  };
};

async function act(
  event: Parameters<NonNullable<Actions['approve']>>[0],
  run: (did: string, adminDid: string) => Promise<unknown>,
) {
  const adminDid = await requireAdmin(event.locals.viewer, '/admin/applications');
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

  /** Grant or withdraw the `administrator` label. */
  grantAdmin: (event) => act(event, (did) => grantLabel(did, ADMINISTRATOR_LABEL)),
  revokeAdmin: (event) => act(event, (did) => clearLabel(did, ADMINISTRATOR_LABEL)),
  revokeSenior: (event) => act(event, (did) => clearLabel(did, SENIOR_LIBRARIAN_LABEL)),
};
