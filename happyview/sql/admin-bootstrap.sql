-- Bootstrap an administrative user and API key for a freshly migrated
-- HappyView, so an installer can upload lexicons and scripts without a
-- dashboard login. Parameterised — the caller supplies psql variables:
--
--   -v user_id=u_pkg_admin -v key_id=k_pkg_admin \
--   -v did=did:web:example.org -v key_hash=<sha256 hex> -v key_prefix=hv_abcd1234
--
-- Idempotent: both rows are fixed ids and are updated in place.
--
-- The permission catalog is materialised on the user *and* on the key. The
-- API-key path computes key.permissions ∩ user.permissions and never consults
-- `is_super` — that short-circuit exists only for cookie sessions — so a
-- superuser with no permission rows authenticates and is then denied.

\set ON_ERROR_STOP on

INSERT INTO happyview.happyview_users (id, created_at, did, is_super)
VALUES (:'user_id', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), :'did', 1)
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
SELECT :'user_id', permission,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM perms
ON CONFLICT (user_id, permission) DO NOTHING;

INSERT INTO happyview.happyview_api_keys
  (id, user_id, name, key_hash, key_prefix, created_at, permissions)
SELECT :'key_id', :'user_id', 'installer deploy',
       :'key_hash', :'key_prefix',
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
