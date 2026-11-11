-- Seed the local HappyView with an administrative user and the credentials the
-- SvelteKit edge will call it with. Local development only.
--
-- Run through `mise run hv-seed` (or psql with -v did=<did>). Idempotent: every
-- row is inserted with a fixed id and updated in place on re-run.
--
--   * happyview_users             — the local PDS account, `is_super` so it owns
--                                   the instance and can sign in to the dashboard.
--   * happyview_user_permissions  — the full permission catalog, every row.
--   * happyview_api_keys          — `hv_dev_admin`, sent as `Authorization:
--                                   Bearer` on /admin/*.
--   * happyview_api_clients       — `hvc_dev_client` / `hvs_dev_secret`, the
--                                   confidential server-to-server client the edge
--                                   sends as X-Client-Key + X-Client-Secret on
--                                   /xrpc/*.
--
-- Permissions are materialised on both the user and the key on purpose. The
-- API-key path computes `key.permissions ∩ user.permissions` and does not
-- consult `is_super` (that short-circuit exists only for cookie sessions), so a
-- superuser with no permission rows authenticates but is denied everything.
--
-- Key hashes are hex SHA-256 of the raw credential, which is what HappyView
-- compares against. Its tables live in the `happyview` schema; this connects as
-- `bibliograph`, which owns that schema, so nothing needs the app role.

\set ON_ERROR_STOP on

INSERT INTO happyview.happyview_users (id, created_at, did, is_super)
VALUES ('u_local_admin', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), :'did', 1)
ON CONFLICT (id) DO UPDATE SET did = EXCLUDED.did, is_super = 1;

WITH perms(permission) AS (VALUES
  ('api-clients:create'), ('api-clients:delete'), ('api-clients:edit'), ('api-clients:view'),
  ('api-keys:create'), ('api-keys:delete'), ('api-keys:read'),
  ('backfill:create'), ('backfill:read'),
  ('dead-letters:manage'), ('dead-letters:read'),
  ('events:purge'), ('events:read'),
  ('jobs:create'), ('jobs:manage'), ('jobs:read'),
  ('labelers:create'), ('labelers:delete'), ('labelers:read'),
  ('lexicons:create'), ('lexicons:delete'), ('lexicons:read'),
  ('linked-repos:create'), ('linked-repos:delete'), ('linked-repos:read'),
  ('plugins:create'), ('plugins:delete'), ('plugins:read'),
  ('records:delete'), ('records:delete-collection'), ('records:read'),
  ('script-variables:create'), ('script-variables:delete'), ('script-variables:read'),
  ('scripts:manage'), ('scripts:read'),
  ('settings:manage'),
  ('spaces:create'), ('spaces:delete'), ('spaces:inspect'), ('spaces:manage-credentials'),
  ('spaces:manage-invites'), ('spaces:manage-members'), ('spaces:manage-records'),
  ('spaces:read'), ('spaces:update'),
  ('stats:read'),
  ('users:create'), ('users:delete'), ('users:read'), ('users:update')
)
INSERT INTO happyview.happyview_user_permissions (user_id, permission, granted_at)
SELECT 'u_local_admin', permission,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM perms
ON CONFLICT (user_id, permission) DO NOTHING;

INSERT INTO happyview.happyview_api_keys
  (id, user_id, name, key_hash, key_prefix, created_at, permissions)
SELECT 'k_local_admin', 'u_local_admin', 'local dev admin',
       encode(sha256('hv_dev_admin'::bytea), 'hex'), 'hv_dev_adm',
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       json_agg(permission)::text
FROM (VALUES
  ('api-clients:create'), ('api-clients:delete'), ('api-clients:edit'), ('api-clients:view'),
  ('api-keys:create'), ('api-keys:delete'), ('api-keys:read'),
  ('backfill:create'), ('backfill:read'),
  ('dead-letters:manage'), ('dead-letters:read'),
  ('events:purge'), ('events:read'),
  ('jobs:create'), ('jobs:manage'), ('jobs:read'),
  ('labelers:create'), ('labelers:delete'), ('labelers:read'),
  ('lexicons:create'), ('lexicons:delete'), ('lexicons:read'),
  ('linked-repos:create'), ('linked-repos:delete'), ('linked-repos:read'),
  ('plugins:create'), ('plugins:delete'), ('plugins:read'),
  ('records:delete'), ('records:delete-collection'), ('records:read'),
  ('script-variables:create'), ('script-variables:delete'), ('script-variables:read'),
  ('scripts:manage'), ('scripts:read'),
  ('settings:manage'),
  ('spaces:create'), ('spaces:delete'), ('spaces:inspect'), ('spaces:manage-credentials'),
  ('spaces:manage-invites'), ('spaces:manage-members'), ('spaces:manage-records'),
  ('spaces:read'), ('spaces:update'),
  ('stats:read'),
  ('users:create'), ('users:delete'), ('users:read'), ('users:update')
) AS perms(permission)
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      key_hash = EXCLUDED.key_hash,
      key_prefix = EXCLUDED.key_prefix,
      permissions = EXCLUDED.permissions,
      revoked_at = NULL;

INSERT INTO happyview.happyview_api_clients
  (id, client_key, name, client_id_url, client_uri, redirect_uris, scopes,
   client_type, is_active, created_by, created_at, updated_at, client_secret_hash)
VALUES
  ('c_local_edge', 'hvc_dev_client', 'Bibliograph edge',
   'http://127.0.0.1:5176', 'http://127.0.0.1:5176', '[]', 'atproto',
   'confidential', 1, 'u_local_admin',
   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   encode(sha256('hvs_dev_secret'::bytea), 'hex'))
ON CONFLICT (id) DO UPDATE
  SET client_key = EXCLUDED.client_key,
      client_secret_hash = EXCLUDED.client_secret_hash,
      is_active = 1;

SELECT 'seeded' AS result,
       (SELECT count(*) FROM happyview.happyview_users WHERE is_super = 1) AS superusers,
       (SELECT count(*) FROM happyview.happyview_user_permissions WHERE user_id = 'u_local_admin') AS user_permissions,
       (SELECT client_key FROM happyview.happyview_api_clients WHERE id = 'c_local_edge') AS client_key;
