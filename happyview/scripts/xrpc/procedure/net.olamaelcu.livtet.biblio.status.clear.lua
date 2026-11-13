-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.status.clear — delete one edition's status.
--
-- The caller's rows are found by the `book.uri` they name: the record key is a
-- TID minted at write time, so deriving it from the edition would miss every
-- row the app wrote. Every match is deleted, like `graph.unfollow`.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local book = strong_ref(input.book, false)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef or {uri} with an at:// uri')
  end

  local rows = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2 AND (record::jsonb)->'book'->>'uri' = $3
       ORDER BY uri ASC]],
    { BOOK_STATUS, caller_did, book.uri }
  )
  local uris = {}
  for _, row in ipairs(rows) do
    if row.uri ~= nil then uris[#uris + 1] = row.uri end
  end
  if #uris == 0 then
    return fail(404, 'NotFound', 'no reading status for ' .. book.uri)
  end

  local records, err = pds_load_all(uris)
  if records == nil then
    return fail(502, 'UpstreamFailure', 'could not load reading statuses: ' .. tostring(err))
  end

  local deleted_uri = nil
  for i = 1, #uris do
    local record = records[i]
    if record ~= nil then
      local failure = pds_delete(record)
      if failure ~= nil then return failure end
      if deleted_uri == nil then deleted_uri = record._uri or uris[i] end
    end
  end

  if deleted_uri == nil then
    return fail(404, 'NotFound', 'no reading status for ' .. book.uri)
  end
  return { uri = deleted_uri }
end
