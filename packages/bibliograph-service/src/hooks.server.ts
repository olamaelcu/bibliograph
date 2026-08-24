import { router } from '$lib/server/xrpc-router';
import { httpRequestDurationMs, normalizePath } from '$lib/server/metrics';

export const handle: import('@sveltejs/kit').Handle = async ({ event, resolve }) => {
  const labels = {
    method: event.request.method,
    path: normalizePath(event.url.pathname),
  };
  const end = httpRequestDurationMs.startTimer(labels);

  if (
    event.url.pathname === '/.well-known/atproto-did' ||
    event.url.pathname === '/.well-known/did.json' ||
    event.url.pathname.startsWith('/.well-known/did.json/')
  ) {
    const res = await resolve(event);
    end({ status: String(res.status) });
    return res;
  }
  if (event.url.pathname === '/xrpc/' || event.url.pathname.startsWith('/xrpc/')) {
    const res = await router.fetch(event.request);
    end({ status: String(res.status) });
    return res;
  }
  const res = await resolve(event);
  end({ status: String(res.status) });
  return res;
};