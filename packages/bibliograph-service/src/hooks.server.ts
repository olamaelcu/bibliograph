import { router } from '$lib/server/xrpc-router';

export const handle: import('@sveltejs/kit').Handle = async ({ event, resolve }) => {
  if (event.url.pathname === '/xrpc/' || event.url.pathname.startsWith('/xrpc/')) {
    return router.fetch(event.request);
  }
  return resolve(event);
};
