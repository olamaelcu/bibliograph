-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.status.set — set one edition's reading status.
--
-- The bookStatus rkey is the edition rkey, so a status change replaces the
-- previous record. On an existing record the metadata is merged, createdAt is
-- kept and updatedAt is bumped.

local STATUSES = { ['to-read'] = true, reading = true, read = true, dnf = true }
local PROGRESS = { 'startedAt', 'finishedAt', 'position', 'notes', 'emoji' }

local function valid_progress(value)
  if type(value) ~= 'table' then
    return nil, '`metadata` must be an object'
  end
  local metadata = {}
  for _, key in ipairs({ 'startedAt', 'finishedAt' }) do
    if value[key] ~= nil then
      if type(value[key]) ~= 'string' then
        return nil, '`metadata.' .. key .. '` must be a datetime string'
      end
      metadata[key] = value[key]
    end
  end
  if value.position ~= nil then
    local position = integer_field(value.position)
    if position == nil or position < 1 then
      return nil, '`metadata.position` must be an integer >= 1'
    end
    metadata.position = position
  end
  for _, key in ipairs({ 'notes', 'emoji' }) do
    if value[key] ~= nil then
      if type(value[key]) ~= 'string' then
        return nil, '`metadata.' .. key .. '` must be a string'
      end
      metadata[key] = value[key]
    end
  end
  return metadata
end

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local book = strong_ref(input.book, true)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef {uri, cid} with an at:// uri')
  end
  local _, _, book_rkey = at_uri_parts(book.uri)

  local status = string_field(input.status)
  if status == nil or not STATUSES[status] then
    return fail(400, 'InvalidRequest', '`status` must be one of to-read, reading, read, dnf')
  end

  local shelf_uri = nil
  if input.shelf ~= nil then
    shelf_uri = string_field(input.shelf)
    if shelf_uri == nil then
      return fail(400, 'InvalidRequest', '`shelf` must be a shelf AT-URI')
    end
    local shelf_did, shelf_collection = at_uri_parts(shelf_uri)
    if shelf_did == nil or shelf_collection ~= SHELF_COLLECTION then
      return fail(400, 'InvalidRequest', '`shelf` must be an AT-URI in ' .. SHELF_COLLECTION)
    end
    if shelf_did ~= caller_did then
      return fail(403, 'Forbidden', 'shelf ' .. shelf_uri .. ' belongs to another DID')
    end
  end

  local provided = nil
  if input.metadata ~= nil then
    local err
    provided, err = valid_progress(input.metadata)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local stamp = now()
  local uri = 'at://' .. caller_did .. '/' .. BOOK_STATUS .. '/' .. book_rkey
  local record = Record.load(uri)

  if record ~= nil then
    local metadata = copy_table(record.metadata)
    merge_fields(metadata, provided, PROGRESS)
    metadata.status = status
    record.book = book
    record.metadata = metadata
    if shelf_uri ~= nil then record.shelf = shelf_uri end
    record.updatedAt = stamp
  else
    local metadata = copy_table(provided)
    metadata.status = status
    local data = {
      book = book,
      metadata = metadata,
      createdAt = stamp,
      updatedAt = stamp,
    }
    if shelf_uri ~= nil then data.shelf = shelf_uri end
    record = Record(BOOK_STATUS, data)
    record:set_rkey(book_rkey)
  end

  record:save()
  return { uri = record._uri, status = status }
end
