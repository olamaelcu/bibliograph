// SvelteKit 3 stopped emitting ambient types for the `$env` modules (explicit
// env moved to `defineEnvVars`/`$app/env`), but `$env/dynamic/private` is still
// the supported way for server code to read runtime configuration. Declare the
// shape this app reads.
declare module '$env/dynamic/private' {
  export const env: Record<string, string | undefined>;
}
