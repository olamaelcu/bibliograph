-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listRecentShelving — network-wide activity.
--
-- bookStatus rows across all readers, keyset `(created_at, uri)` descending,
-- with a per-request cache for edition/shelf lookups.

function handle()
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor)
  local cursor_t = string_field(cursor.t) or ''
  local cursor_u = string_field(cursor.u) or ''
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1
         AND ($2 = '' OR (created_at, uri) < ($2, $3))
       ORDER BY created_at DESC, uri DESC
       LIMIT $4]],
    { BOOK_STATUS, cursor_t, cursor_u, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = book_shelf_view(rows[i], cache)
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { bookShelves = toarray(out) }
  if #rows > limit then
    local last = rows[limit]
    response.cursor = encode_cursor({ t = last.created_at, u = last.uri })
  end
  return response
end
