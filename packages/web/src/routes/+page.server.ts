import type { PageServerLoad } from './$types';
import { currentSession } from '../lib/server/oauth/flow';

export const load: PageServerLoad = ({ cookies }) => {
  const session = currentSession(cookies);
  return {
    session: session
      ? { did: session.did, handle: session.handle, scopes: session.scopes }
      : null
  };
};
