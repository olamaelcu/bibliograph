-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.removeItem — take a book off a shelf.
--
-- The rkey is derived from the two URIs, so the record to delete is known
-- without a query. `book` may be a strongRef or a bare {uri}. The shelf must
-- belong to the caller, but does not need to still exist: a missing item is a
-- 404 either way.

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
  local _, _, book_rkey = at_uri_parts(book.uri)

  local rkey = shelf.rkey .. '-' .. book_rkey
  if #rkey > 512 then
    return fail(400, 'InvalidRequest', 'the derived shelfItem rkey is longer than 512 characters')
  end
  local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey

  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', book.uri .. ' is not on ' .. shelf.uri)
  end

  failure = pds_delete(record)
  if failure ~= nil then return failure end
  return { uri = uri }
end
