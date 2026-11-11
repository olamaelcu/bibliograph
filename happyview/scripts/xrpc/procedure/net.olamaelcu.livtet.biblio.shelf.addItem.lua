-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addItem — put a book on a shelf.
--
-- The shelfItem rkey is derived (`<shelf rkey>-<edition rkey>`), so the pair
-- (shelf, book) always maps to one record and a second call updates it.

local function valid_metadata(value)
  if type(value) ~= 'table' then
    return nil, '`metadata` must be an object'
  end
  local metadata = {}
  if value.position ~= nil then
    local position = integer_field(value.position)
    if position == nil or position < 1 then
      return nil, '`metadata.position` must be an integer >= 1'
    end
    metadata.position = position
  end
  if value.notes ~= nil then
    if type(value.notes) ~= 'string' then
      return nil, '`metadata.notes` must be a string'
    end
    metadata.notes = value.notes
  end
  if value.emoji ~= nil then
    if type(value.emoji) ~= 'string' then
      return nil, '`metadata.emoji` must be a string'
    end
    metadata.emoji = value.emoji
  end
  return metadata
end

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

  local book = strong_ref(input.book, true)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef {uri, cid} with an at:// uri')
  end
  local _, _, book_rkey = at_uri_parts(book.uri)

  local provided = nil
  if input.metadata ~= nil then
    local err
    provided, err = valid_metadata(input.metadata)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local rkey = shelf_rkey .. '-' .. book_rkey
  if #rkey > 512 then
    return fail(400, 'InvalidRequest', 'the derived shelfItem rkey is longer than 512 characters')
  end
  local uri = 'at://' .. caller_did .. '/' .. SHELF_ITEM .. '/' .. rkey
  local stamp = now()

  local record = Record.load(uri)
  if record ~= nil then
    local metadata = copy_table(record.metadata)
    merge_fields(metadata, provided, { 'position', 'notes', 'emoji' })
    record.shelf = shelf_uri
    record.book = book
    record.metadata = metadata
    record.updatedAt = stamp
  else
    local metadata = copy_table(provided)
    record = Record(SHELF_ITEM, {
      shelf = shelf_uri,
      book = book,
      metadata = metadata,
      createdAt = stamp,
      updatedAt = stamp,
    })
    record:set_rkey(rkey)
  end

  record:save()
  return { uri = record._uri }
end
