-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.create — create a shelf at a fresh TID.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local name, err = required_string(input.name, 'name')
  if err ~= nil then
    return fail(400, 'InvalidRequest', err)
  end
  if #name > 128 then
    return fail(400, 'InvalidRequest', '`name` must be at most 128 characters')
  end

  local description = nil
  if input.description ~= nil then
    if type(input.description) ~= 'string' then
      return fail(400, 'InvalidRequest', '`description` must be a string')
    end
    description = input.description
  end

  local stamp = now()
  local data = { name = name, createdAt = stamp, updatedAt = stamp }
  if description ~= nil then data.description = description end

  local record = Record(SHELF_COLLECTION, data)
  record:set_rkey(TID())
  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri }
end
