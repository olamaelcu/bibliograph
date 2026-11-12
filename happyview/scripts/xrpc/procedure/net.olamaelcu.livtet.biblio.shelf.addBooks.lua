-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addBooks — batch shelf.addItem.
--
-- Every entry is validated first; entries that fail validation (bad strongRef,
-- duplicate pair inside the request) are counted in `failed` instead of
-- failing the call. The valid ones are written with Record.save_all, which
-- issues the PDS writes in parallel. The target shelf is checked for existence
-- and ownership before any record is written.

local MAX_BOOKS = 100

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

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
      local rkey = shelf.rkey .. '-' .. book_rkey
      if #rkey > 512 or seen[rkey] then
        failed = failed + 1
      else
        seen[rkey] = true
        local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey
        local record = Record.load(uri)
        if record ~= nil then
          record.shelf = shelf.uri
          record.book = book
          record.updatedAt = stamp
        else
          record = Record(SHELF_ITEM, {
            shelf = shelf.uri,
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
    failure = pds_save_all(records)
    if failure ~= nil then return failure end
  end

  return { added = #records, failed = failed }
end
