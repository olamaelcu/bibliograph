// Public `/xrpc/<nsid>` gateway.
//
// Route order: edge handlers, then the PDS proxy for protocol endpoints, then
// HappyView for activity queries/procedures. `/xrpc/*` is always served by the
// SvelteKit process; HappyView is reached at its internal `/<BASE_PATH>/xrpc`
// path only.

import { handleEdgeXrpc } from './xrpc-edge';
import { proxyToPds } from './pds-proxy';
import { hvRequest } from './happyview/client';

const PDS_NSID = /^com\.atproto\.(repo|sync|identity)\.|^com\.atproto\.server\.describeServer$/;

export async function handleXrpc(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const nsid = decodeURIComponent(url.pathname.slice('/xrpc/'.length));
	if (!nsid.includes('.')) {
		return Response.json({ error: 'InvalidRequest', message: 'A valid NSID is required' }, { status: 400 });
	}

	const edge = await handleEdgeXrpc(request, nsid);
	if (edge) return edge;

	if (PDS_NSID.test(nsid)) return proxyToPds(request, nsid);

	return hvRequest(request, nsid);
}
