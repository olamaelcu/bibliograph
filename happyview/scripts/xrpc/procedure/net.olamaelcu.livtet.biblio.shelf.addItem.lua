-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addItem — put a book on a shelf.
--
-- The shelfItem rkey is derived (`<shelf rkey>-<edition rkey>`), so the pair
-- (shelf, book) always maps to one record and a second call updates it. The
-- target shelf must exist and belong to the caller; a missing shelf is 404.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

  local book = strong_ref(input.book, true)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef {uri, cid} with an at:// uri')
  end
  local _, _, book_rkey = at_uri_parts(book.uri)

  local provided = nil
  if input.metadata ~= nil then
    local err
    provided, err = shelf_item_metadata(input.metadata)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local rkey = shelf.rkey .. '-' .. book_rkey
  if #rkey > 512 then
    return fail(400, 'InvalidRequest', 'the derived shelfItem rkey is longer than 512 characters')
  end
  local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey
  local stamp = now()

  local record = Record.load(uri)
  if record ~= nil then
    local metadata = copy_table(record.metadata)
    merge_fields(metadata, provided, { 'position', 'notes', 'emoji' })
    record.shelf = shelf.uri
    record.book = book
    record.metadata = metadata
    record.updatedAt = stamp
  else
    local metadata = copy_table(provided)
    record = Record(SHELF_ITEM, {
      shelf = shelf.uri,
      book = book,
      metadata = metadata,
      createdAt = stamp,
      updatedAt = stamp,
    })
    record:set_rkey(rkey)
  end

  failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri }
end
