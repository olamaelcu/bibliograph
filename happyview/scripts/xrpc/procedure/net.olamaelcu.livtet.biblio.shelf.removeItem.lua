-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.removeItem — take a book off a shelf.
--
-- The rkey is derived from the two URIs, so the record to delete is known
-- without a query. `book` may be a strongRef or a bare {uri}.

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

  local book = strong_ref(input.book, false)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef or {uri} with an at:// uri')
  end
  local _, _, book_rkey = at_uri_parts(book.uri)

  local rkey = shelf_rkey .. '-' .. book_rkey
  if #rkey > 512 then
    return fail(400, 'InvalidRequest', 'the derived shelfItem rkey is longer than 512 characters')
  end
  local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey

  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', book.uri .. ' is not on ' .. shelf_uri)
  end

  record:delete()
  return { uri = uri }
end
