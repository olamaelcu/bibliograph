-- Bootstrap the confidential XRPC client the SvelteKit edge authenticates
-- with. Called by `hv-client` before HappyView starts, because HappyView loads
-- client identities into memory at boot and would not know this key otherwise.
--
-- Parameterised (psql -v): client_id, client_key, client_uri, scopes,
-- created_by, secret_hash.
--
-- Idempotent on the fixed id: a rerun rotates the stored hash and scopes in
-- place. The raw secret never reaches the database — only its SHA-256, which
-- is what HappyView compares against.

\set ON_ERROR_STOP on

INSERT INTO happyview.happyview_api_clients
  (id, client_key, name, client_id_url, client_uri, redirect_uris, scopes,
   client_type, is_active, created_by, created_at, updated_at, client_secret_hash)
VALUES
  (:'client_id', :'client_key', 'Bibliograph edge',
   :'client_uri', :'client_uri', '[]', :'scopes',
   'confidential', 1, :'created_by',
   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   :'secret_hash')
ON CONFLICT (id) DO UPDATE
  SET client_key = EXCLUDED.client_key,
      client_id_url = EXCLUDED.client_id_url,
      client_uri = EXCLUDED.client_uri,
      scopes = EXCLUDED.scopes,
      client_secret_hash = EXCLUDED.client_secret_hash,
      is_active = 1,
      updated_at = EXCLUDED.updated_at;
