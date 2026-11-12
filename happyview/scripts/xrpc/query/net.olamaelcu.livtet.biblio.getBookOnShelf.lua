-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getBookOnShelf — one bookStatus record hydrated.
--
-- A missing record, or a catalog edition/shelf that cannot be resolved, is
-- `404 RecordNotFound`. The per-request cache keeps the edition and shelf
-- lookups single even when the caller builds several views.

function handle()
  local uri, err = required_at_uri(params.uri, 'uri')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local rows = db.raw(
    'SELECT uri, did, record FROM happyview_records WHERE uri = $1 AND collection = $2 LIMIT 1',
    { uri, BOOK_STATUS }
  )
  local row = rows[1]
  if row == nil then
    return fail(404, 'RecordNotFound', 'No bookStatus record exists at ' .. uri)
  end
  local view = book_shelf_view(row, view_cache())
  if view == nil then
    local record = record_value(row.record)
    local bookUri = record.book and record.book.uri or 'unknown'
    return fail(404, 'RecordNotFound', 'Catalog edition is missing for ' .. bookUri)
  end
  return { bookShelf = view }
end
