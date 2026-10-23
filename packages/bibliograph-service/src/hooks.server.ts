import { router } from '$lib/server/xrpc-router';
import { httpRequestDurationMs, normalizePath } from '$lib/server/metrics';
import { SESSION_COOKIE, readWebSession } from '$lib/server/auth/session';

// Session lookup is a DB round trip, so it is skipped for everything that can
// never render a signed-in UI: XRPC, well-known documents, probes, and assets.
function needsViewer(pathname: string): boolean {
  return !(
    pathname.startsWith('/xrpc/') ||
    pathname.startsWith('/_app/') ||
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/oauth-client-metadata.json') ||
    pathname === '/health' ||
    pathname === '/metrics' ||
    /\.[a-z0-9]+$/i.test(pathname)
  );
}

export const handle: import('@sveltejs/kit').Handle = async ({ event, resolve }) => {
  const labels = {
    method: event.request.method,
    path: normalizePath(event.url.pathname),
  };
  const end = httpRequestDurationMs.startTimer(labels);

  event.locals.viewer = null;
  if (needsViewer(event.url.pathname)) {
    try {
      event.locals.viewer = await readWebSession(event.cookies.get(SESSION_COOKIE));
    } catch {
      // A session lookup failure must not take the page down; treat as anonymous.
      event.locals.viewer = null;
    }
  }

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