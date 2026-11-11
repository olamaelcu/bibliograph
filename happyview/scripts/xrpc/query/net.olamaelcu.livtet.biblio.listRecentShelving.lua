-- @include lib/prelude.lua
function handle()
  local limit = int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1
         AND ($2 = '' OR (created_at, uri) < ($2, $3))
       ORDER BY created_at DESC, uri DESC
       LIMIT $4]],
    { BOOK_SHELVING, cursor.t or '', cursor.u or '', limit + 1 }
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
