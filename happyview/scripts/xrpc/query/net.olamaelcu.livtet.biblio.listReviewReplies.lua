-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listReviewReplies — one review's replies.
--
-- Replies are public records in their authors' repos, so the conversation is
-- discovered by subject rather than by fanning out over repos. Oldest first: a
-- conversation reads top to bottom, unlike a reaction list.
--
-- Each reply carries the reactions naming it, so a bar needs no second call.
-- One query per reply rather than `ANY($n)`: no script here binds an array
-- parameter, and the reaction-subject index makes each lookup cheap. The
-- platform asks for 20 per page; a deeper page ships no reactions.
--
-- Cursor advances by `limit` (the rows the page emits), not by `limit + 1`
-- (the probe row it scanned).

function handle()
  local subject, err = required_at_uri(params.subject, 'subject')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 20, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at
        FROM happyview_records
       WHERE collection = $1
         AND (record::jsonb)->>'subject' = $2
       ORDER BY created_at ASC, uri ASC
       LIMIT $3 OFFSET $4]],
    { REVIEW_REPLY_COLLECTION, subject, limit + 1, offset }
  )

  local count = math.min(#rows, limit)
  local emoji_type = REACTION_COLLECTION .. '#unicodeEmoji'
  local reactions = {}
  if count > 0 and count <= 20 then
    for i = 1, count do
      local reaction_rows = db.raw(
        [[SELECT uri, did, record, created_at
            FROM happyview_records
           WHERE collection = $1
             AND (record::jsonb)->'subject'->>'uri' = $2
           ORDER BY created_at ASC, uri ASC]],
        { REACTION_COLLECTION, rows[i].uri }
      )
      local list = {}
      for j = 1, #reaction_rows do
        local record = record_value(reaction_rows[j].record)
        local value = record.value
        local emoji = nil
        if type(value) == 'table' and value['$type'] == emoji_type then
          emoji = string_field(value.value)
        end
        if emoji ~= nil then
          list[#list + 1] = {
            ['$type'] = 'net.olamaelcu.livtet.biblio.defs#reactionView',
            uri = reaction_rows[j].uri,
            did = reaction_rows[j].did,
            emoji = emoji,
            createdAt = reaction_rows[j].created_at,
          }
        end
      end
      reactions[rows[i].uri] = list
    end
  end

  local out = {}
  for i = 1, count do
    out[#out + 1] = {
      ['$type'] = 'net.olamaelcu.livtet.biblio.defs#reviewReplyView',
      uri = rows[i].uri,
      did = rows[i].did,
      record = record_value(rows[i].record),
      reactions = toarray(reactions[rows[i].uri] or {}),
    }
  end

  local response = { replies = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
