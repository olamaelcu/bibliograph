import type { LayoutServerLoad } from './$types';
import { isAdministrator } from '$lib/server/labeler/librarian';

// The signed-in viewer is resolved in hooks.server.ts and surfaced to every page
// via layout data, so the top bar can render sign-in/out without each page
// forwarding it.
//
// `viewerIsAdmin` decides whether the top bar offers the admin entrance. It is
// presentation only: every /admin route re-checks on the server, so a stale or
// spoofed flag grants nothing.
export const load: LayoutServerLoad = async ({ locals }) => ({
  viewer: locals.viewer,
  viewerIsAdmin: locals.viewer ? await isAdministrator(locals.viewer.did) : false,
});
