/**
 * NSID dispatch for `/xrpc/[...method]`.
 *
 * Split out of the SvelteKit route so the method classification — and the
 * response every branch produces — is testable without `$env` or the catalog
 * database. The route injects the actual handlers; `dispatch*` only decides
 * which one runs and never touches CORS (the route's wrapper applies it to
 * whatever comes back, including the 400/405 branches here).
 */

import {
  EDGE_PROCEDURES,
  ENTITY_PROCEDURES,
  ENTITY_QUERIES,
  RESOLVE_EDITIONS,
  SEARCH_EDITIONS
} from '../catalog/entity-methods.ts';
import { DESCRIBE_FEED_GENERATOR, GET_FEED_SKELETON } from '../feeds/methods.ts';
import { isPdsRead } from '../pds-methods.ts';
import { xrpcPreflight } from './cors.ts';
import { SERVICE_DESCRIBE } from './surface.ts';

/**
 * An NSID is at least three labels: the reversed-domain authority (one or more
 * labels) and the name. No label may be empty.
 */
const NSID = /^[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63})+\.[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

export function isNsid(method: string): boolean {
  return typeof method === 'string' && NSID.test(method);
}

/** The edge-served handlers, injected so this module stays dependency-free. */
export type XrpcDependencies = {
  serviceDescribe: () => Response | Promise<Response>;
  describeFeedGenerator: () => Response | Promise<Response>;
  getFeedSkeleton: (request: Request) => Response | Promise<Response>;
  entityGet: (request: Request, method: string) => Response | Promise<Response>;
  resolveEditions: (request: Request) => Response | Promise<Response>;
  searchEditions: (request: Request) => Response | Promise<Response>;
  entityResolve: (request: Request, method: string) => Response | Promise<Response>;
  proxyPdsRead: (method: string, request: Request) => Response | Promise<Response>;
  forward: (method: string, request: Request) => Response | Promise<Response>;
};

function jsonFailure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function invalidRequest(): Response {
  return jsonFailure(400, 'InvalidRequest');
}

function methodNotAllowed(): Response {
  return jsonFailure(405, 'MethodNotAllowed');
}

export function dispatchGet(
  method: string,
  request: Request,
  dependencies: XrpcDependencies
): Response | Promise<Response> {
  if (!isNsid(method)) return invalidRequest();
  // The surface description is static, so it answers before any handler that
  // might need a setting (`FEED_GENERATOR_DID`, `DATABASE_URL`) or a PDS.
  if (method === SERVICE_DESCRIBE) return dependencies.serviceDescribe();
  // The feed generator is served at the edge from the activity index; it is a
  // GET-only pair, and `public` is the only anonymous feed.
  if (method === DESCRIBE_FEED_GENERATOR) return dependencies.describeFeedGenerator();
  if (method === GET_FEED_SKELETON) return dependencies.getFeedSkeleton(request);
  if (ENTITY_QUERIES.has(method)) return dependencies.entityGet(request, method);
  // The books-wg and entity procedures are POST-only.
  if (EDGE_PROCEDURES.has(method) || ENTITY_PROCEDURES.has(method)) return methodNotAllowed();
  // Publisher-record reads go to the PDS; other com.atproto methods still go
  // to HappyView below.
  if (isPdsRead(method)) return dependencies.proxyPdsRead(method, request);
  return dependencies.forward(method, request);
}

export function dispatchPost(
  method: string,
  request: Request,
  dependencies: XrpcDependencies
): Response | Promise<Response> {
  if (!isNsid(method)) return invalidRequest();
  if (method === SERVICE_DESCRIBE) return methodNotAllowed();
  if (method === DESCRIBE_FEED_GENERATOR || method === GET_FEED_SKELETON) {
    return methodNotAllowed();
  }
  if (method === RESOLVE_EDITIONS) return dependencies.resolveEditions(request);
  if (method === SEARCH_EDITIONS) return dependencies.searchEditions(request);
  if (ENTITY_PROCEDURES.has(method)) return dependencies.entityResolve(request, method);
  // Entity getters and searches are GET-only.
  if (ENTITY_QUERIES.has(method)) return methodNotAllowed();
  return dependencies.forward(method, request);
}

/** A preflight is answered for every valid NSID, served here or forwarded. */
export function dispatchOptions(method: string): Response {
  if (!isNsid(method)) return invalidRequest();
  return xrpcPreflight();
}

/**
 * `PUT`/`PATCH`/`DELETE` are never part of XRPC. A valid NSID answers 405; an
 * invalid path keeps the same 400 the other verbs give it.
 */
export function dispatchMethodNotAllowed(method: string): Response {
  if (!isNsid(method)) return invalidRequest();
  return methodNotAllowed();
}
