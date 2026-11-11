-- @include lib/prelude.lua
function handle()
  local did = params.did
  if did == nil then return fail(400, 'InvalidRequest', 'did is required') end
  local limit = int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor).u or ''

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1 AND did = $2 AND ($3 = '' OR uri > $3)
       ORDER BY uri ASC
       LIMIT $4]],
    { SHELF_COLLECTION, did, cursor, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    out[#out + 1] = shelf_view(rows[i].uri, rows[i].record)
  end
  local response = { shelves = toarray(out) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].uri }) end
  return response
end
