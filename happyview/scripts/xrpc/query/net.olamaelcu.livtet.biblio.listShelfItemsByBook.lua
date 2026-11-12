-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listShelfItemsByBook — one reader's shelf items
-- for one book, ordered by URI ascending with an offset cursor.

function handle()
  local book, err = required_at_uri(params.book, 'book')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->'book'->>'uri' = $3
       ORDER BY uri ASC
       LIMIT $4 OFFSET $5]],
    { SHELF_ITEM, did, book, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = shelf_item_view(rows[i], cache)
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { items = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
