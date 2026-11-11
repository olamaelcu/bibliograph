-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.update — rename / re-describe a shelf.
--
-- Load → mutate → save, so fields the input omits keep their stored value and
-- createdAt is carried over by the loaded record.

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

  local name = nil
  if input.name ~= nil then
    name = string_field(input.name)
    if name == nil then
      return fail(400, 'InvalidRequest', '`name` must be a non-empty string')
    end
    if #name > 128 then
      return fail(400, 'InvalidRequest', '`name` must be at most 128 characters')
    end
  end

  local description = nil
  if input.description ~= nil then
    if type(input.description) ~= 'string' then
      return fail(400, 'InvalidRequest', '`description` must be a string')
    end
    description = input.description
  end

  local record = Record.load(shelf_uri)
  if record == nil then
    return fail(404, 'NotFound', 'no shelf record at ' .. shelf_uri)
  end

  local updated = false
  if name ~= nil then
    record.name = name
    updated = true
  end
  if description ~= nil then
    record.description = description
    updated = true
  end
  record.updatedAt = now()
  record:save()

  return { uri = record._uri, updated = updated }
end
