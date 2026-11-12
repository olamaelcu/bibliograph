-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.graph.listFollowees — who `did` follows.
--
-- Follow rkeys are opaque TIDs now, so the page orders and keysets on `rkey`
-- (stable and sortable) but reads the followed DID from the record's `subject`
-- field. Legacy rows may store subject as `at://<did>` or keep the subject DID
-- as their rkey; only the subject is used for the output.

local function subject_did(row, record)
  local subject = row.subject
  if subject == nil then subject = record.subject end
  if type(subject) ~= 'string' then return nil end
  -- Accept both `did:...` and legacy `at://did:...` (or a full at-uri).
  subject = subject:match('^at://([^/]+)') or subject
  if is_did(subject) then return subject end
  return nil
end

-- The page and the total use the same DID-shaped-subject predicate, so total
-- cannot count rows the page would omit. Mirrors `is_did` in lib/core.lua.
local SUBJECT_SQL = [[(
       (record::jsonb)->>'subject' ~ '^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$'
    OR (record::jsonb)->>'subject' ~ '^at://did:[a-z0-9]+:[A-Za-z0-9._:%-]+(/.*)?$'
  )]]

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 100, 1, 1000)
  local cursor = string_field(params.cursor) or ''
  -- TIDs are 13 characters. A pre-TID cursor was a DID; restarting is safer
  -- than comparing it against TIDs and silently skipping the first page.
  if #cursor ~= 13 then cursor = '' end

  local rows = db.raw(
    [[SELECT uri, did, record, created_at, rkey, (record::jsonb)->>'subject' AS subject
       FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND ]] .. SUBJECT_SQL .. [[
         AND ($3 = '' OR rkey > $3)
       ORDER BY rkey ASC
       LIMIT $4]],
    { FOLLOW_COLLECTION, did, cursor, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local row = rows[i]
    local record = record_value(row.record)
    local subject = subject_did(row, record)
    if subject ~= nil then
      out[#out + 1] = {
        did = subject,
        followedAt = record.createdAt or row.created_at,
      }
    end
  end

  local counted = db.raw(
    'SELECT count(*)::int AS n FROM happyview_records WHERE collection = $1 AND did = $2 AND ' .. SUBJECT_SQL,
    { FOLLOW_COLLECTION, did }
  )

  local response = { followees = toarray(out), total = counted[1] and counted[1].n or 0 }
  if #rows > limit then response.cursor = rows[limit].rkey end
  return response
end
