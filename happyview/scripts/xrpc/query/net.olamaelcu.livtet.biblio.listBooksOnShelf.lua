-- @include lib/prelude.lua
function handle()
  local shelf = params.shelf
  if shelf == nil then return fail(400, 'InvalidRequest', 'shelf is required') end
  local did = did_of(shelf)
  if did == nil then return fail(400, 'InvalidRequest', 'shelf must be an AT-URI') end
  local limit = int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor)

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->>'shelf' = $3
         AND ($4 = '' OR (created_at, uri) < ($4, $5))
       ORDER BY created_at DESC, uri DESC
       LIMIT $6]],
    { BOOK_STATUS, did, shelf, cursor.t or '', cursor.u or '', limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = book_shelf_view(rows[i])
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { bookShelves = toarray(out) }
  if #rows > limit then
    local last = rows[limit]
    response.cursor = encode_cursor({ t = last.created_at, u = last.uri })
  end
  return response
end
