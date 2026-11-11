import { defineEnvVars } from '@sveltejs/kit/env';

// SvelteKit 3 exposes only the variables declared here to `$env/dynamic/private`
// (undeclared ones are absent, not merely untyped). All three are server-only
// and read when the process starts, so they stay runtime-configurable. Each
// validator returns the value unchanged, which marks the variable optional:
// `HAPPYVIEW_URL` has a fallback, and the AppView serves anonymous XRPC calls
// when no client credentials are configured.
export const variables = defineEnvVars({
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
  }
});
