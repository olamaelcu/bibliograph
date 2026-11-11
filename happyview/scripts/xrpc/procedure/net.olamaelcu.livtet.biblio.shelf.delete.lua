-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.delete — cascading shelf delete.
--
-- Every shelfItem and every bookStatus whose `shelf` is this URI goes first,
-- then the shelf itself. The records are found through the local index (the
-- record JSON is text, so the shelf URI is compared after decoding) and each
-- delete goes through the Record API, so the caller's PDS is updated too.

local CASCADE = { SHELF_ITEM, BOOK_STATUS }

local function records_referencing(shelf_uri)
  local found = {}
  for _, collection_name in ipairs(CASCADE) do
    local rows = db.raw(
      [[SELECT uri, record FROM happyview.happyview_records
         WHERE did = $1 AND collection = $2]],
      { caller_did, collection_name }
    )
    for _, row in ipairs(rows) do
      local value = record_value(row.record)
      if value.shelf == shelf_uri then
        found[#found + 1] = row.uri
      end
    end
  end
  return found
end

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf_uri = string_field(input.shelf)
  if shelf_uri == nil then
    return fail(400, 'InvalidRequest', '`shelf` must be a shelf AT-URI')
  end
  local did, coll = at_uri_parts(shelf_uri)
  if did == nil or coll ~= SHELF_COLLECTION then
    return fail(400, 'InvalidRequest', '`shelf` must be an AT-URI in ' .. SHELF_COLLECTION)
  end
  if did ~= caller_did then
    return fail(403, 'Forbidden', 'shelf ' .. shelf_uri .. ' belongs to another DID')
  end

  local shelf = Record.load(shelf_uri)
  if shelf == nil then
    return fail(404, 'NotFound', 'no shelf record at ' .. shelf_uri)
  end

  local deleted = 0
  for _, uri in ipairs(records_referencing(shelf_uri)) do
    local dependent = Record.load(uri)
    if dependent ~= nil then
      dependent:delete()
      deleted = deleted + 1
    end
  end

  shelf:delete()
  return { deleted = deleted + 1 }
end
