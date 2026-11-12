-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.listFollowees — who `did` follows.
--
-- The follow record's rkey is the subject DID by contract, so the page sorts
-- and keysets on `rkey`: an indexed column, unlike the previously derived
-- `split_part(regexp_replace(subject, ...))` expression. `total` is required by
-- the lexicon, so it is counted on every page, not only the first.

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 100, 1, 1000)
  local cursor = string_field(params.cursor) or ''

  local rows = db.raw(
    [[SELECT uri, did, record, created_at, rkey AS subject_did
       FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ($3 = '' OR rkey > $3)
       ORDER BY rkey ASC
       LIMIT $4]],
    { FOLLOW_COLLECTION, did, cursor, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local row = rows[i]
    local record = record_value(row.record)
    out[#out + 1] = {
      did = row.subject_did,
      followedAt = record.createdAt or row.created_at,
    }
  end

  local counted = db.raw(
    'SELECT count(*)::int AS n FROM happyview_records WHERE collection = $1 AND did = $2',
    { FOLLOW_COLLECTION, did }
  )

  local response = { followees = toarray(out), total = counted[1] and counted[1].n or 0 }
  if #rows > limit then response.cursor = rows[limit].subject_did end
  return response
end
