// Element definitions on the server too, so Svelte renders the tags as custom
// elements. Web Awesome's shadow DOM is not server-rendered; the slotted light
// DOM (all of the page content) is, which is what matters for the docs.
import '$lib/webawesome/components';
import type { Handle } from '@sveltejs/kit/hooks';

import { metrics, recordHttpRequest } from '$lib/server/metrics';
import { buildServiceDidDocument } from '$lib/server/service-did';
import { env } from '$env/dynamic/private';

/**
 * Record every HTTP request at the SvelteKit boundary.
 *
 * Labels are bounded by construction: the verb is normalized to a fixed set,
 * the route is SvelteKit's matched route id (a manifest pattern such as
 * `/xrpc/[...method]`, never the request URL), and the status is a numeric
 * code. A request that matches no route is labelled `unmatched`.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const started = performance.now();
  let status = 500;
  try {
    // `did:web` requires the document under `/.well-known/`, which SvelteKit
    // treats as a non-route directory, so it is answered here. Consumers
    // re-resolve it (a PDS on every space access), hence a short cache.
    if (event.url.pathname === '/.well-known/did.json') {
      const response = Response.json(
        buildServiceDidDocument({
          hostname: env.LIVTET_DID_HOSTNAME ?? '',
          interactionKeyMultibase: env.LIVTET_INTERACTION_KEY_MULTIBASE ?? null,
          spaceManagerEndpoint: env.LIVTET_SPACE_MANAGER_ENDPOINT ?? ''
        }),
        {
          headers: {
            'cache-control': 'public, max-age=300, must-revalidate',
            'access-control-allow-origin': '*'
          }
        }
      );
      status = response.status;
      return response;
    }
    const response = await resolve(event);
    status = response.status;
    return response;
  } finally {
    recordHttpRequest(metrics, {
      method: event.request.method,
      route: event.route.id,
      status,
      durationSeconds: (performance.now() - started) / 1000
    });
  }
};
