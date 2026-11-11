-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addBooks — batch shelf.addItem.
--
-- Every entry is validated first; entries that fail validation (bad strongRef,
-- duplicate pair inside the request) are counted in `failed` instead of
-- failing the call. The valid ones are written with Record.save_all, which
-- issues the PDS writes in parallel.

local MAX_BOOKS = 100

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf_uri = string_field(input.shelf)
  if shelf_uri == nil then
    return fail(400, 'InvalidRequest', '`shelf` must be a shelf AT-URI')
  end
  local shelf_did, shelf_collection, shelf_rkey = at_uri_parts(shelf_uri)
  if shelf_did == nil or shelf_collection ~= SHELF_COLLECTION then
    return fail(400, 'InvalidRequest', '`shelf` must be an AT-URI in ' .. SHELF_COLLECTION)
  end
  if shelf_did ~= caller_did then
    return fail(403, 'Forbidden', 'shelf ' .. shelf_uri .. ' belongs to another DID')
  end

  if type(input.books) ~= 'table' then
    return fail(400, 'InvalidRequest', '`books` must be an array of strongRefs')
  end
  if #input.books > MAX_BOOKS then
    return fail(400, 'InvalidRequest', '`books` may hold at most ' .. MAX_BOOKS .. ' entries')
  end

  local stamp = now()
  local records = {}
  local seen = {}
  local failed = 0

  for _, entry in ipairs(input.books) do
    local book = strong_ref(entry, true)
    if book == nil then
      failed = failed + 1
    else
      local _, _, book_rkey = at_uri_parts(book.uri)
      local rkey = shelf_rkey .. '-' .. book_rkey
      if #rkey > 512 or seen[rkey] then
        failed = failed + 1
      else
        seen[rkey] = true
        local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey
        local record = Record.load(uri)
        if record ~= nil then
          record.shelf = shelf_uri
          record.book = book
          record.updatedAt = stamp
        else
          record = Record(SHELF_ITEM, {
            shelf = shelf_uri,
            book = book,
            createdAt = stamp,
            updatedAt = stamp,
          })
          record:set_rkey(rkey)
        end
        records[#records + 1] = record
      end
    end
  end

  if #records > 0 then
    local ok, err = pcall(function() return Record.save_all(records) end)
    if not ok then
      return fail(502, 'UpstreamFailure', 'the PDS rejected the batch: ' .. tostring(err))
    end
  end

  return { added = #records, failed = failed }
end
