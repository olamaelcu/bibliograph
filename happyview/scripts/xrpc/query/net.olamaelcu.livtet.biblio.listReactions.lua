-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listReactions — one record's reactions.
--
-- Reads the shared reaction collection filtered on the subject's uri. The
-- subject is a strongRef, so the filter is on `subject.uri`; a reaction whose
-- `value` is not a Unicode emoji is skipped rather than guessed at — the
-- union is open, and a later revision may carry an image or a label.
--
-- Club reactions are not here: they are records inside the club's space and
-- are read through the club, under its own access rule.
--
-- Newest first, offset cursor. The cursor advances by `limit` (the number of
-- rows the page emits), not by `limit + 1` (the probe row it scanned).

function handle()
  local subject, err = required_at_uri(params.subject, 'subject')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at
        FROM happyview_records
       WHERE collection = $1
         AND (record::jsonb)->'subject'->>'uri' = $2
       ORDER BY created_at DESC, uri DESC
       LIMIT $3 OFFSET $4]],
    { REACTION_COLLECTION, subject, limit + 1, offset }
  )

  local emoji_type = REACTION_COLLECTION .. '#unicodeEmoji'
  local out = {}
  for i = 1, math.min(#rows, limit) do
    local record = record_value(rows[i].record)
    local value = record.value
    local emoji = nil
    if type(value) == 'table' and value['$type'] == emoji_type then
      emoji = string_field(value.value)
    end
    if emoji ~= nil then
      out[#out + 1] = {
        ['$type'] = 'net.olamaelcu.livtet.biblio.defs#reactionView',
        uri = rows[i].uri,
        did = rows[i].did,
        emoji = emoji,
        createdAt = rows[i].created_at,
      }
    end
  end
  local response = { reactions = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
