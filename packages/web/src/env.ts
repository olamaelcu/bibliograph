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
  }
});
