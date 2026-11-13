-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.removeItem — take a book off a shelf.
--
-- The items are found by the fields they name: the caller's shelfItem rows
-- whose `record.shelf` is this shelf and whose `record.book.uri` is this book.
-- The rkey is a TID minted at write time, so deriving it from the two URIs
-- would miss the app's rows. Every match is deleted. `book` may be a strongRef
-- or a bare {uri}. The shelf must belong to the caller, but does not need to
-- still exist: a missing item is a 404 either way.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = shelf_ref(input.shelf)
  if failure ~= nil then return failure end

  local book = strong_ref(input.book, false)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef or {uri} with an at:// uri')
  end

  local rows = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND (record::jsonb)->>'shelf' = $3
         AND (record::jsonb)->'book'->>'uri' = $4
       ORDER BY uri ASC]],
    { SHELF_ITEM, caller_did, shelf.uri, book.uri }
  )
  local uris = {}
  for _, row in ipairs(rows) do
    if row.uri ~= nil then uris[#uris + 1] = row.uri end
  end
  if #uris == 0 then
    return fail(404, 'NotFound', book.uri .. ' is not on ' .. shelf.uri)
  end

  local records, err = pds_load_all(uris)
  if records == nil then
    return fail(502, 'UpstreamFailure', 'could not load shelf items: ' .. tostring(err))
  end

  local deleted_uri = nil
  for i = 1, #uris do
    local record = records[i]
    if record ~= nil then
      failure = pds_delete(record)
      if failure ~= nil then return failure end
      if deleted_uri == nil then deleted_uri = record._uri or uris[i] end
    end
  end

  if deleted_uri == nil then
    return fail(404, 'NotFound', book.uri .. ' is not on ' .. shelf.uri)
  end
  return { uri = deleted_uri }
end
