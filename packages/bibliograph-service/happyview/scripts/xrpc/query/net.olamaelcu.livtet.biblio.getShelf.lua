-- @include lib/prelude.lua
function handle()
  local uri = params.uri
  if uri == nil then return fail(400, 'InvalidRequest', 'uri is required') end
  local rows = db.raw(
    'SELECT uri, did, record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, SHELF_COLLECTION }
  )
  local row = rows[1]
  if row == nil then
    return fail(404, 'RecordNotFound', 'No shelf record exists at ' .. uri)
  end
  return { shelf = shelf_view(row.uri, record_value(row.record)) }
end
