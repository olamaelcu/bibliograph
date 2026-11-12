-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.delete — cascading shelf delete.
--
-- Every shelfItem and bookStatus whose `record.shelf` is this URI is selected
-- through the partial expression index on `(record::jsonb)->>'shelf'` (no Lua
-- scan), loaded in one `Record.load_all` batch, then deleted through the
-- Record API so the caller's PDS is updated too. The shelf itself goes last.

local CASCADE = { SHELF_ITEM, BOOK_STATUS }

local function records_referencing(shelf_uri)
  local found = {}
  for _, collection_name in ipairs(CASCADE) do
    local rows = db.raw(
      [[SELECT uri FROM happyview_records
         WHERE did = $1 AND collection = $2 AND (record::jsonb)->>'shelf' = $3]],
      { caller_did, collection_name, shelf_uri }
    )
    for _, row in ipairs(rows) do
      found[#found + 1] = row.uri
    end
  end
  return found
end

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

  local uris = records_referencing(shelf.uri)
  local deleted = 0
  if #uris > 0 then
    local records, err = pds_load_all(uris)
    if records == nil then
      return fail(502, 'UpstreamFailure', 'could not load shelf contents: ' .. tostring(err))
    end
    for _, record in ipairs(records) do
      if record ~= nil then
        failure = pds_delete(record)
        if failure ~= nil then return failure end
        deleted = deleted + 1
      end
    end
  end

  failure = pds_delete(shelf.record)
  if failure ~= nil then return failure end
  return { deleted = deleted + 1 }
end
