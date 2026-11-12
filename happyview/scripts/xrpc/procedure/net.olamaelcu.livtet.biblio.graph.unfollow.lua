-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.unfollow — delete a follow by subject DID.
--
-- The follow record is keyed by the followed DID, so the URI follows from the
-- input alone. A missing record is a 404, not a silent success: the caller
-- asked to remove a follow that is not there.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local subject = string_field(input.subject)
  if subject == nil then
    return fail(400, 'InvalidRequest', '`subject` must be a non-empty DID string')
  end
  if not is_did(subject) then
    return fail(400, 'InvalidRequest', '`subject` must be a DID of the form did:<method>:<identifier>')
  end

  local uri = 'at://' .. caller_did .. '/' .. FOLLOW_COLLECTION .. '/' .. subject
  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', 'no follow record at ' .. uri)
  end

  local failure = pds_delete(record)
  if failure ~= nil then return failure end
  return { uri = uri }
end
