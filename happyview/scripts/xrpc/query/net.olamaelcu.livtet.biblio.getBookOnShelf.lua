-- @include lib/prelude.lua
function handle()
  local uri = params.uri
  if uri == nil then return fail(400, 'InvalidRequest', 'uri is required') end
  local rows = db.raw(
    'SELECT uri, did, record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, BOOK_STATUS }
  )
  local row = rows[1]
  if row == nil then
    return fail(404, 'RecordNotFound', 'No bookStatus record exists at ' .. uri)
  end
  local view = book_shelf_view(row)
  if view == nil then
    local record = record_value(row.record)
    local bookUri = record.book and record.book.uri or 'unknown'
    return fail(404, 'RecordNotFound', 'Catalog edition is missing for ' .. bookUri)
  end
  return { bookShelf = view }
end
