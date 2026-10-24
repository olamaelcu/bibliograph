import { fail, redirect } from '@sveltejs/kit';
import { loadRecord } from '$lib/server/record-detail';
import {
  editionUriForRkey,
  getEditionWorkStatus,
} from '$lib/server/edition-work-votes';
import { submitEditionWorkVote, VoteError } from '$lib/server/edition-work-actions';
import { PUBLISHER_DID } from '$lib/server/did';
import { clearLabel, grantLabel, hasLabel, isLibrarian } from '$lib/server/labeler/labels';
import { applicationFor, isAdministrator, requestLibrarianAccess } from '$lib/server/labeler/librarian';
import { CONTROVERSIAL_LABEL } from '$lib/server/labeler/vocabulary';
import { log, searchService } from '$lib/server/xrpc-router';
import type { Actions, PageServerLoad } from './$types';

const CANDIDATE_LIMIT = 8;

export const load: PageServerLoad = async ({ params, locals }) => {
  const record = await loadRecord('editions', params.rkey);
  const editionUri = editionUriForRkey(params.rkey, PUBLISHER_DID);

  // Curation rights come from the labeler, not from being signed in.
  const viewerDid = locals.viewer?.did ?? null;
  const [canCurate, application, controversial, canLabel] = await Promise.all([
    viewerDid ? isLibrarian(viewerDid) : Promise.resolve(false),
    viewerDid ? applicationFor(viewerDid) : Promise.resolve(null),
    hasLabel(editionUri, CONTROVERSIAL_LABEL),
    viewerDid ? isAdministrator(viewerDid) : Promise.resolve(false),
  ]);

  if (record.notFound) {
    return { ...record, workStatus: null, candidates: [], canCurate, application, controversial, canLabel };
  }

  const workStatus = await getEditionWorkStatus(editionUri, locals.viewer?.did ?? null);

  // Offer near matches by title so linking does not require pasting a URI.
  let candidates: Array<{ uri: string; title: string; year?: number }> = [];
  if ('title' in record.value && record.value.title) {
    try {
      const result = await searchService.searchWorks({ q: record.value.title, limit: CANDIDATE_LIMIT });
      candidates = result.items.map((w) => ({ uri: w.uri, title: w.title, year: w.firstPublishedYear }));
    } catch (err) {
      log.warn({ err, rkey: params.rkey }, 'work candidate search failed; continuing without suggestions');
    }
  }

  return { ...record, workStatus, candidates, canCurate, application, controversial, canLabel };
};

async function castVote(
  action: 'link' | 'unlink',
  event: Parameters<NonNullable<Actions['linkWork']>>[0],
) {
  const { params, locals, request } = event;
  if (!locals.viewer) {
    redirect(303, `/login?next=${encodeURIComponent(`/editions/${params.rkey}`)}`);
  }

  let workUri: string | undefined;
  if (action === 'link') {
    const form = await request.formData();
    workUri = String(form.get('workUri') ?? '').trim();
    if (!workUri) return fail(400, { error: 'Pick a work to link this edition to.' });
  }

  if (!(await isLibrarian(locals.viewer.did))) {
    return fail(403, { error: 'Only accounts holding the librarian label can vote. Request access below.' });
  }

  try {
    const result = await submitEditionWorkVote({
      did: locals.viewer.did,
      editionRkey: params.rkey,
      action,
      workUri,
    });
    return {
      ok: true,
      applied: result.consensus.decision.action,
      recordUri: result.recordUri,
    };
  } catch (err) {
    if (err instanceof VoteError) return fail(400, { error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, action, rkey: params.rkey }, 'vote submission failed');
    return fail(502, { error: `Could not write to your repository: ${message}` });
  }
}

export const actions: Actions = {
  linkWork: (event) => castVote('link', event),
  unlinkWork: (event) => castVote('unlink', event),

  /** Flip the `controversial` label on this edition record (administrators only). */
  toggleControversial: async ({ params, locals }) => {
    if (!locals.viewer) redirect(303, `/login?next=/editions/${params.rkey}`);
    if (!(await isAdministrator(locals.viewer.did))) {
      return fail(403, { error: 'Only administrators can label catalog records.' });
    }
    const uri = editionUriForRkey(params.rkey, PUBLISHER_DID);
    const currently = await hasLabel(uri, CONTROVERSIAL_LABEL);
    if (currently) await clearLabel(uri, CONTROVERSIAL_LABEL);
    else await grantLabel(uri, CONTROVERSIAL_LABEL);
    return { ok: true, controversial: !currently };
  },

  /** Ask an admin to issue the librarian label to the signed-in account. */
  requestLibrarian: async ({ locals, request }) => {
    if (!locals.viewer) {
      redirect(303, '/login?next=/');
    }
    const form = await request.formData();
    const note = String(form.get('note') ?? '').trim().slice(0, 1000) || null;
    const existing = await applicationFor(locals.viewer.did);
    if (existing && (existing.status === 'approved' || existing.status === 'revoked')) {
      return fail(400, { error: `Your application is already ${existing.status}.` });
    }
    await requestLibrarianAccess(locals.viewer.did, locals.viewer.handle, note);
    return { ok: true, requested: true };
  },
};
