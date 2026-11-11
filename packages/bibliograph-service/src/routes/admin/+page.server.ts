import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';
import { listApplications } from '$lib/server/labeler/librarian';

export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  const pending = await listApplications('pending');
  return { pendingApplications: pending.length };
};
