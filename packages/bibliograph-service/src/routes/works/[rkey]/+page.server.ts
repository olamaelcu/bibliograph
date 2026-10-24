import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { loadRecord } from '$lib/server/record-detail';
import { PUBLISHER_DID } from '$lib/server/did';
import { clearLabel, grantLabel, hasLabel } from '$lib/server/labeler/labels';
import { isAdministrator } from '$lib/server/labeler/librarian';
import { CONTROVERSIAL_LABEL } from '$lib/server/labeler/vocabulary';

const COLLECTION = 'community.lexicon.book.work';

function workUri(rkey: string): string {
  return `at://${PUBLISHER_DID}/${COLLECTION}/${rkey}`;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const record = await loadRecord('works', params.rkey);
  const uri = workUri(params.rkey);
  const viewerDid = locals.viewer?.did ?? null;
  const [controversial, canLabel] = await Promise.all([
    hasLabel(uri, CONTROVERSIAL_LABEL),
    viewerDid ? isAdministrator(viewerDid) : Promise.resolve(false),
  ]);
  return { ...record, controversial, canLabel };
};

export const actions: Actions = {
  /** Flip the `controversial` label on this work record (administrators only). */
  toggleControversial: async ({ params, locals }) => {
    if (!locals.viewer) redirect(303, `/login?next=/works/${params.rkey}`);
    if (!(await isAdministrator(locals.viewer.did))) {
      return fail(403, { error: 'Only administrators can label catalog records.' });
    }
    const uri = workUri(params.rkey);
    const currently = await hasLabel(uri, CONTROVERSIAL_LABEL);
    if (currently) await clearLabel(uri, CONTROVERSIAL_LABEL);
    else await grantLabel(uri, CONTROVERSIAL_LABEL);
    return { ok: true, controversial: !currently };
  },
};
