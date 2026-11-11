-- @include lib/prelude.lua
function handle()
  local shelf = params.shelf
  if shelf == nil then return fail(400, 'InvalidRequest', 'shelf is required') end
  local did = did_of(shelf)
  if did == nil then return fail(400, 'InvalidRequest', 'shelf must be an AT-URI') end
  local limit = int(params.limit, 50, 1, 100)
  local offset = tonumber(decode_cursor(params.cursor).o) or 0

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->>'shelf' = $3
       ORDER BY uri ASC
       LIMIT $4 OFFSET $5]],
    { SHELF_ITEM, did, shelf, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = shelf_item_view(rows[i])
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { items = toarray(out) }
  if #rows > limit then response.cursor = encode_cursor({ o = offset + #rows }) end
  return response
end
