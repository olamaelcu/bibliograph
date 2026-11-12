-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listBooksOnShelf — one shelf's bookStatus rows.
--
-- Keyset over `(created_at, uri)` descending. `created_at` must be selected:
-- the cursor is built from the last scanned row, so omitting it emitted a
-- cursor with no timestamp. The per-request cache deduplicates edition/shelf
-- lookups across the page.

function handle()
  local shelf, err = required_at_uri(params.shelf, 'shelf')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local did = did_of(shelf)
  if did == nil then return fail(400, 'InvalidRequest', 'shelf must be an AT-URI') end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor)
  local cursor_t = string_field(cursor.t) or ''
  local cursor_u = string_field(cursor.u) or ''
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->>'shelf' = $3
         AND ($4 = '' OR (created_at, uri) < ($4, $5))
       ORDER BY created_at DESC, uri DESC
       LIMIT $6]],
    { BOOK_STATUS, did, shelf, cursor_t, cursor_u, limit + 1 }
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
