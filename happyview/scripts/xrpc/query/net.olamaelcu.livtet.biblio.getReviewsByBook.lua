-- @include lib/prelude.lua
function handle()
  local book = params.book
  if book == nil then return fail(400, 'InvalidRequest', 'book is required') end
  local limit = int(params.limit, 25, 1, 100)
  local offset = tonumber(decode_cursor(params.cursor).o) or 0

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1
         AND (
           (record::jsonb)->>'subjectRecord' = $2
           OR EXISTS (
             SELECT 1 FROM edition_identifiers i
             WHERE i.edition_uri = $2
               AND (record::jsonb)->'subject'->'identifiers'
                   @> jsonb_build_array(jsonb_build_object('issuer', i.issuer, 'value', i.value))
           )
         )
       ORDER BY created_at DESC, uri DESC
       LIMIT $3 OFFSET $4]],
    { REVIEW_COLLECTION, book, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    out[#out + 1] = review_view(rows[i])
  end
  local response = { reviews = toarray(out) }
  if #rows > limit then response.cursor = encode_cursor({ o = offset + #rows }) end
  return response
end
