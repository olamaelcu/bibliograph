-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.follow — follow a DID.
--
-- The follow record is keyed by the followed DID, so this is an upsert: a
-- second call finds the record at the same URI and leaves it untouched.

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
  if subject == caller_did then
    return fail(400, 'InvalidRequest', 'a reader cannot follow themselves')
  end

  local uri = 'at://' .. caller_did .. '/' .. FOLLOW_COLLECTION .. '/' .. subject
  local existing = Record.load(uri)
  if existing ~= nil then
    return { uri = existing._uri, created = false }
  end

  local record = Record(FOLLOW_COLLECTION, { subject = subject, createdAt = now() })
  record:set_rkey(subject)
  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri, created = true }
end
