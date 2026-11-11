-- @include lib/prelude.lua
function handle()
  local did = params.did
  if did == nil then return fail(400, 'InvalidRequest', 'did is required') end
  local limit = int(params.limit, 25, 1, 100)
  local offset = tonumber(decode_cursor(params.cursor).o) or 0

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1 AND did = $2
       ORDER BY created_at DESC, uri DESC
       LIMIT $3 OFFSET $4]],
    { REVIEW_COLLECTION, did, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    out[#out + 1] = review_view(rows[i])
  end
  local response = { reviews = toarray(out) }
  if #rows > limit then response.cursor = encode_cursor({ o = offset + #rows }) end
  return response
end
