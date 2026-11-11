import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';
import {
  applicationsForDids,
  grantLibrarianDirect,
  revokeLibrarian,
} from '$lib/server/labeler/librarian';
import { activeSubjects } from '$lib/server/labeler/labels';
import { LIBRARIAN_LABEL } from '$lib/server/labeler/vocabulary';
import { actorHandle, resolveActorDid } from '$lib/server/pds/resolve';
import { createLogger } from '$lib/server/logger';
const log = createLogger('web');

export interface LibrarianRow {
  did: string;
  handle: string | null;
  note: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
}

export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  const dids = await activeSubjects(LIBRARIAN_LABEL);
  const applications = await applicationsForDids(dids);
  const librarians: LibrarianRow[] = await Promise.all(
    dids.map(async (did) => {
      const row = applications.get(did) ?? null;
      const handle = row?.handle ?? (await actorHandle(did).catch(() => null));
      return {
        did,
        handle,
        note: row?.note ?? null,
        decidedAt: row?.decidedAt ?? null,
        decidedBy: row?.decidedBy ?? null,
      };
    }),
  );
  return { librarians };
};

/** Resolve the form's DID-or-handle input to a DID. */
async function targetFrom(event: Parameters<NonNullable<Actions['issue']>>[0]) {
  const form = await event.request.formData();
  const raw = String(form.get('account') ?? '').trim().replace(/^@/, '');
  const note = String(form.get('note') ?? '').trim() || null;
  if (raw === '') return { error: 'Enter the account DID or handle.' as const };
  const did = await resolveActorDid(raw);
  if (!did) return { error: `Could not resolve "${raw}" to a DID.` as const };
  return { did, note };
}

export const actions: Actions = {
  issue: async (event) => {
    const adminDid = requireAdmin(event);
    const target = await targetFrom(event);
    if ('error' in target) return fail(400, { error: target.error });
    try {
      const row = await grantLibrarianDirect(target.did, adminDid, target.note);
      log.info({ stage: 'admin-librarian', did: target.did, adminDid }, 'librarian label issued');
      return { ok: true, did: row.did };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ stage: 'admin-librarian', err, did: target.did, adminDid }, 'librarian label issue failed');
      return fail(502, { error: message });
    }
  },

  revoke: async (event) => {
    const adminDid = requireAdmin(event);
    const form = await event.request.formData();
    const did = String(form.get('did') ?? '').trim();
    if (!did.startsWith('did:')) return fail(400, { error: 'Expected a DID' });
    try {
      await revokeLibrarian(did, adminDid);
      log.info({ stage: 'admin-librarian', did, adminDid }, 'librarian label revoked');
      return { ok: true, did };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ stage: 'admin-librarian', err, did, adminDid }, 'librarian label revoke failed');
      return fail(502, { error: message });
    }
  },
};
