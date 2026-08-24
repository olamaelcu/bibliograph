import { loadRecord } from '$lib/server/record-detail';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => loadRecord('contributors', params.rkey);
