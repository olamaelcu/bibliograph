-- @include lib/prelude.lua
function handle()
  local book = params.book
  local did = params.did
  if book == nil or did == nil then
    return fail(400, 'InvalidRequest', 'book and did are required')
  end
  local limit = int(params.limit, 50, 1, 100)
  local offset = tonumber(decode_cursor(params.cursor).o) or 0

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->'book'->>'uri' = $3
       ORDER BY uri ASC
       LIMIT $4 OFFSET $5]],
    { BOOK_STATUS, did, book, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = book_shelf_view(rows[i])
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { bookShelves = toarray(out) }
  if #rows > limit then response.cursor = encode_cursor({ o = offset + #rows }) end
  return response
end
