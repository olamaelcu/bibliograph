-- Input validators shared by the XRPC write procedures. Included by
-- lib/prelude.lua. Each returns the accepted value, or nil plus a failure
-- envelope (or, for the pure value validators, nil plus an error message).

-- Parse a shelf AT-URI and check the caller owns it. Returns
-- `{ uri, did, rkey }`, or nil plus a `400`/`403` envelope.
local function shelf_ref(value)
  local uri = string_field(value)
  if uri == nil then
    return nil, fail(400, 'InvalidRequest', '`shelf` must be a shelf AT-URI')
  end
  local did, coll, rkey = at_uri_parts(uri)
  if did == nil or coll ~= SHELF_COLLECTION then
    return nil, fail(400, 'InvalidRequest', '`shelf` must be an AT-URI in ' .. SHELF_COLLECTION)
  end
  if did ~= caller_did then
    return nil, fail(403, 'Forbidden', 'shelf ' .. uri .. ' belongs to another DID')
  end
  return { uri = uri, did = did, rkey = rkey }
end

-- `shelf_ref` plus a local existence check: every writer that stores a shelf
-- reference must prove the shelf exists, because the read views drop records
-- whose shelf cannot be resolved. Returns the record as `shelf.record`.
local function owned_shelf(value)
  local shelf, failure = shelf_ref(value)
  if failure ~= nil then return nil, failure end
  local record = Record.load(shelf.uri)
  if record == nil then
    return nil, fail(404, 'NotFound', 'no shelf record at ' .. shelf.uri)
  end
  shelf.record = record
  return shelf
end

-- A review `subject` editionRef: non-empty title, identifiers array, and a
-- contributors array (which may be empty).
local function edition_ref(value)
  if type(value) ~= 'table' then
    return nil, '`subject` must be an editionRef object'
  end
  if type(value.title) ~= 'string' or value.title == '' then
    return nil, '`subject.title` must be a non-empty string'
  end
  if type(value.identifiers) ~= 'table' or #value.identifiers < 1 then
    return nil, '`subject.identifiers` must be a non-empty array'
  end
  if type(value.contributors) ~= 'table' then
    return nil, '`subject.contributors` must be an array (it may be empty)'
  end
  return value
end

-- Shared metadata validation. `spec` is a list of `{ key, kind }` (integer
-- fields carry a third minimum). Unknown keys are ignored, matching the
-- record's open metadata object.
local function metadata_fields(value, spec)
  if type(value) ~= 'table' then
    return nil, '`metadata` must be an object'
  end
  local metadata = {}
  for _, field in ipairs(spec) do
    local key, kind, minimum = field[1], field[2], field[3]
    local item = value[key]
    if item ~= nil then
      if kind == 'integer' then
        local n = integer_field(item)
        if n == nil or n < (minimum or 1) then
          return nil, '`metadata.' .. key .. '` must be an integer >= ' .. (minimum or 1)
        end
        metadata[key] = n
      else
        if type(item) ~= 'string' then
          return nil, '`metadata.' .. key .. '` must be a string'
        end
        metadata[key] = item
      end
    end
  end
  return metadata
end

-- `shelfItem.metadata` (shelf.addItem).
local function shelf_item_metadata(value)
  return metadata_fields(value, {
    { 'position', 'integer', 1 },
    { 'notes', 'string' },
    { 'emoji', 'string' },
  })
end

-- `bookStatus.metadata` (status.set), including the reading progress fields.
local function status_metadata(value)
  return metadata_fields(value, {
    { 'startedAt', 'string' },
    { 'finishedAt', 'string' },
    { 'position', 'integer', 1 },
    { 'notes', 'string' },
    { 'emoji', 'string' },
  })
end
