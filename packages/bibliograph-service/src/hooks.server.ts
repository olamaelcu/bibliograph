import { handleXrpc } from '$lib/server/xrpc-gateway';
import { httpRequestDurationMs, normalizePath } from '$lib/server/metrics';

// No end-user session: the AppView serves anonymous reads. The only
// authentication is per-call (service JWT for personalized feeds, admin token
// for the admin pages), resolved where it is needed.

export const handle: import('@sveltejs/kit/hooks').Handle = async ({ event, resolve }) => {
	const end = httpRequestDurationMs.startTimer({
		method: event.request.method,
		path: normalizePath(event.url.pathname),
	});

	if (event.url.pathname === '/xrpc/' || event.url.pathname.startsWith('/xrpc/')) {
		const res = await handleXrpc(event.request);
		// Public reads are cacheable; anything authenticated, non-GET, failed, or
		// already carrying its own directive (the CAR responses) is not touched.
		const cacheable =
			event.request.method === 'GET' &&
			!event.request.headers.has('authorization') &&
			res.status === 200 &&
			!res.headers.has('cache-control');
		if (!cacheable) {
			end({ status: String(res.status) });
			return res;
		}
		const headers = new Headers(res.headers);
		headers.set('cache-control', 'public, max-age=60, stale-while-revalidate=300');
		end({ status: String(res.status) });
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	}

	const res = await resolve(event);
	end({ status: String(res.status) });
	return res;
};
