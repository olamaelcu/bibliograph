import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { loadRecord } from '$lib/server/record-detail';
import { PUBLISHER_DID } from '$lib/server/did';
import { isAdministrator } from '$lib/server/labeler/librarian';
import { log } from '$lib/server/xrpc-router';
import {
  enqueueContributorBioBackfill,
  enqueueContributorImageBackfill,
} from '$lib/server/jobs/enqueue';

const COLLECTION = 'community.lexicon.book.contributor';

function contributorUri(rkey: string): string {
  return `at://${PUBLISHER_DID}/${COLLECTION}/${rkey}`;
}

export const load: PageServerLoad = async ({ params, parent }) => {
  // The admin bit is the layout's own query — reuse it instead of a second
  // isAdministrator round trip per page view.
  const [record, { viewerIsAdmin }] = await Promise.all([
    loadRecord('contributors', params.rkey),
    parent(),
  ]);
  return { ...record, canLabel: viewerIsAdmin };
};

export const actions: Actions = {
  /** Queue the portrait + bio backfills for this contributor (administrators only). */
  runBackfill: async ({ params, locals }) => {
    const next = `/contributors/${params.rkey}`;
    if (!locals.viewer) redirect(303, `/login?next=${encodeURIComponent(next)}`);
    if (!(await isAdministrator(locals.viewer.did))) {
      return fail(403, { error: 'Only administrators can queue backfills.' });
    }
    const uri = contributorUri(params.rkey);
    await Promise.all([
      enqueueContributorImageBackfill(uri),
      enqueueContributorBioBackfill(uri),
    ]);
    log.info(
      { stage: 'contributor-backfill', rkey: params.rkey, did: locals.viewer.did },
      'contributor image+bio backfill queued by administrator',
    );
    return { ok: true, backfill: true };
  },
};
