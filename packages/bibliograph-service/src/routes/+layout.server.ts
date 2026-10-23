import type { LayoutServerLoad } from './$types';

// The signed-in viewer is resolved in hooks.server.ts and surfaced to every page
// via layout data, so the top bar can render sign-in/out without each page
// forwarding it.
export const load: LayoutServerLoad = async ({ locals }) => ({
  viewer: locals.viewer,
});
