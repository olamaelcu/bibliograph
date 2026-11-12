-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listShelfItems — a shelf's item records.
--
-- Ordered by URI ascending, offset cursor; editions and shelves are looked up
-- through the per-request cache.

function handle()
  local shelf, err = required_at_uri(params.shelf, 'shelf')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local did = did_of(shelf)
  if did == nil then return fail(400, 'InvalidRequest', 'shelf must be an AT-URI') end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->>'shelf' = $3
       ORDER BY uri ASC
       LIMIT $4 OFFSET $5]],
    { SHELF_ITEM, did, shelf, limit + 1, offset }
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
