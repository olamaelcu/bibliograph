-- @include lib/prelude.lua
function handle()
  local bookUri = params.bookUri
  if bookUri == nil then return fail(400, 'InvalidRequest', 'bookUri is required') end
  local shelvingRkey = params.shelvingRkey
  if shelvingRkey == nil or shelvingRkey == '' then
    shelvingRkey = string.match(bookUri, '([^/]+)$') or ''
  end
  local limit = int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor).u or ''

  local rows = db.raw(
    [[SELECT did, min(uri) AS first_uri FROM happyview_records
       WHERE collection = $1 AND rkey = $2 AND (record::jsonb)->'book'->>'uri' = $3
       GROUP BY did
       HAVING ($4 = '' OR min(uri) > $4)
       ORDER BY first_uri ASC
       LIMIT $5]],
    { BOOK_SHELVING, shelvingRkey, bookUri, cursor, limit + 1 }
  )

  local dids = {}
  for i = 1, math.min(#rows, limit) do
    dids[#dids + 1] = rows[i].did
  end
  local response = { bookUri = bookUri, dids = toarray(dids) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].first_uri }) end
  return response
end
