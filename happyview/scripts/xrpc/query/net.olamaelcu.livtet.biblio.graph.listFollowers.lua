-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.listFollowers — who follows `did`.
--
-- Rows whose subject is `did`, legacy `at://did`, or a full AT-URI under that
-- DID are matched through the indexed full-subject expression. A reader follows
-- a DID, so several rows can name one follower (a stale at-uri spelling next to
-- the current one); the page is one row per follower and `total` counts
-- followers, not rows.
--
-- `total` is required by the lexicon, so it is counted on every page.

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 100, 1, 1000)
  local cursor = string_field(params.cursor) or ''

  local rows = db.raw(
    [[SELECT did, min(uri) AS first_uri,
             (array_agg(COALESCE((record::jsonb)->>'createdAt', created_at) ORDER BY uri))[1] AS followed_at
        FROM happyview_records
       WHERE collection = $1
         AND ((record::jsonb)->>'subject' = $2
              OR (record::jsonb)->>'subject' = 'at://' || $2
              OR (record::jsonb)->>'subject' LIKE 'at://' || $2 || '/%')
       GROUP BY did
      HAVING ($3 = '' OR did > $3)
       ORDER BY did ASC
       LIMIT $4]],
    { FOLLOW_COLLECTION, did, cursor, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local row = rows[i]
    out[#out + 1] = {
      did = row.did,
      followedAt = row.followed_at,
    }
  end

  local counted = db.raw(
    [[SELECT count(DISTINCT did)::int AS n FROM happyview_records
       WHERE collection = $1
         AND ((record::jsonb)->>'subject' = $2
              OR (record::jsonb)->>'subject' = 'at://' || $2
              OR (record::jsonb)->>'subject' LIKE 'at://' || $2 || '/%')]],
    { FOLLOW_COLLECTION, did }
  )

  local response = { followers = toarray(out), total = counted[1] and counted[1].n or 0 }
  if #rows > limit then response.cursor = rows[limit].did end
  return response
end
