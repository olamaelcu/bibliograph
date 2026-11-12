-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getShelf — one shelf record as a shelfView.

function handle()
  local uri, err = required_at_uri(params.uri, 'uri')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local rows = db.raw(
    'SELECT uri, did, record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, SHELF_COLLECTION }
  )
  local row = rows[1]
  if row == nil then
    return fail(404, 'RecordNotFound', 'No shelf record exists at ' .. uri)
  end
  return { shelf = shelf_view(row.uri, row.record) }
end
