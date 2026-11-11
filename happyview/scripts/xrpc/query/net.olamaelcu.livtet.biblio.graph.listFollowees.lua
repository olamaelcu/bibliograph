-- @include lib/prelude.lua
function handle()
  local did = params.did
  if did == nil then return fail(400, 'InvalidRequest', 'did is required') end
  local limit = int(params.limit, 100, 1, 1000)
  local cursor = params.cursor or ''

  local rows = db.raw(
    [[SELECT uri, did, record,
             split_part(regexp_replace((record::jsonb)->>'subject', '^at://', ''), '/', 1) AS subject_did
       FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ($3 = '' OR split_part(regexp_replace((record::jsonb)->>'subject', '^at://', ''), '/', 1) > $3)
       ORDER BY subject_did ASC
       LIMIT $4]],
    { FOLLOW_COLLECTION, did, cursor, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local row = rows[i]
    out[#out + 1] = {
      did = row.subject_did,
      followedAt = record_value(row.record).createdAt or row.created_at,
    }
  end

  local response = { followees = toarray(out) }
  if cursor == '' then
    local counted = db.raw(
      'SELECT count(*)::int AS n FROM happyview_records WHERE collection = $1 AND did = $2',
      { FOLLOW_COLLECTION, did }
    )
    response.total = counted[1] and counted[1].n or 0
  end
  if #rows > limit then response.cursor = rows[limit].subject_did end
  return response
end
