import { defineEnvVars } from '@sveltejs/kit/env';

// SvelteKit 3 exposes only the variables declared here to `$env/dynamic/private`
// (undeclared ones are absent, not merely untyped). Every entry is server-only
// and read when the process starts, so they stay runtime-configurable. Schema
// functions mark a variable optional by returning `undefined`: `HAPPYVIEW_URL`
// has a fallback, the AppView serves anonymous XRPC calls when no client
// credentials are configured, and an unset `ADMIN_TOKEN` disables /admin.
export const variables = defineEnvVars({
  DATABASE_URL: {
    schema: (value) => value,
    description: 'Postgres URL for the catalog tables served by the books-wg procedures.'
  },
  HAPPYVIEW_URL: {
    schema: (value) => value,
    description: 'Base URL of the AppView service, e.g. http://127.0.0.1:3000.'
  },
  HAPPYVIEW_CLIENT_KEY: {
    schema: (value) => value,
    description: 'XRPC client key the edge presents upstream; never accepted from callers.'
  },
  HAPPYVIEW_CLIENT_SECRET: {
    schema: (value) => value,
    description: 'Secret proving the edge owns HAPPYVIEW_CLIENT_KEY.'
  },
  PDS_URL: {
    schema: (value) => value,
    description:
      'Base URL of the PDS that owns publisher records; GET com.atproto.repo.getRecord/listRecords are proxied there.'
  },
  ADMIN_TOKEN: {
    schema: (value) => value,
    description:
      'Operator token for /admin. Unset disables the admin UI and APIs with 404; never sent to the browser.'
  },
  WORKER_ADMIN_URL: {
    schema: (value) => value ?? 'http://127.0.0.1:9465',
    description:
      'Loopback base URL of the worker admin API used by /admin for provider search and ingest.'
  },
  FEED_GENERATOR_DID: {
    schema: (value) => value,
    description:
      'Required. DID the edge feed generator advertises and accepts as the aud authority; also the authority of every feed URI. There is no code default: feed methods answer 503 when it is unset.'
  },
  PLC_URL: {
    schema: (value) => value,
    description:
      'Required for personalized feeds. PLC directory used to resolve did:plc service-token issuers; there is no code default, so following/extended/dynamic answer 503 when it is unset or blank.'
  },
  LIVTET_DID_HOSTNAME: {
    schema: (value) => value?.trim() || 'biblio.livtet.olamaelcu.net',
    description:
      'Host whose /.well-known/did.json this app serves as did:web:<host>. The Livtet platform signs against that identity; set it only for a non-production host.'
  },
  LIVTET_INTERACTION_KEY_MULTIBASE: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Public half of the platform LIVTET_ASSERTION_KEY, published as #oauth_interaction. Unset serves a document with no verification method, and MCP sign-in fails until it is set.'
  },
  LIVTET_SPACE_MANAGER_ENDPOINT: {
    schema: (value) => value?.trim() || 'https://livtet.olamaelcu.net',
    description:
      'Service endpoint published as #livtet_space_manager; the base URL a PDS calls to mint and check club spaces.'
  },
  LIVTET_LABELER_KEY_MULTIBASE: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Public half of the labeler key, published as #atproto_label. Unset omits the verification method, and consumers cannot verify the labels the worker signs.'
  },
  LIVTET_LABELER_ORIGIN: {
    schema: (value) => value?.trim() || 'https://biblio.livtet.olamaelcu.net',
    description:
      'Origin published as #atproto_labeler. The labeler is served from this host through nginx, so it must be the origin the two label endpoints answer on — a path-less origin, as the label spec requires.'
  },
  LIBRARIAN_DIDS: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Comma- or space-separated DIDs allowed into /librarian. Unset disables the whole tree (404).'
  },
  LIBRARIAN_SESSION_SECRET: {
    schema: (value) => value?.trim() || undefined,
    description:
      'HMAC key for the librarian session cookie. Unset disables the whole /librarian tree (404).'
  },
  COVERS_CACHE_DIR: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Directory bibliograph-worker writes cached cover images to and /api/covers reads. No code default: unset means no cover caching, and the endpoint answers the provider redirect instead of a cached image.'
  },
  COVERS_PUBLIC_BASE_URL: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Public origin the /api/covers URLs advertise. Unset keeps the provider URL in edition views and records, so caching still works but the hotlink is not replaced.'
  },
  COVERS_RATE_LIMIT_PER_MINUTE: {
    schema: (value) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 600;
    },
    description:
      'Per-client-IP allowance on /api/covers, also the burst size. Raise it for a busy shared egress; lower it to bound a scraper.'
  },
  SEARCH_BACKEND: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Which engine answers a text search: `postgres`, `shadow` (serve Postgres, only measure the index) or `tantivy` (serve the index, fall back to Postgres on any failure). Unset or unrecognised keeps Postgres authoritative.'
  },
  SEARCH_URL: {
    schema: (value) => value?.trim() || undefined,
    description:
      'Loopback base URL of bibliograph-search. Unset keeps the index off whatever SEARCH_BACKEND names.'
  },
  SEARCH_ENGINE_TIMEOUT_MS: {
    schema: (value) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    },
    description:
      'Budget for one index call before the request falls back to Postgres. Blank or invalid falls back to 400 ms in code.'
  },
  SEARCH_HYDRATION_THRESHOLD: {
    schema: (value) => value?.trim() || undefined,
    description:
      'First-page total below which a text search queues a provider search. Blank or invalid falls back to 10 in code; 0 disables provider hydration.'
  }
});
