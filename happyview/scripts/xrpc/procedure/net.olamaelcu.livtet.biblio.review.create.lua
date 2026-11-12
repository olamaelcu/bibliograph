-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.review.create — create a review at a fresh TID.
--
-- `subject` is a self-contained editionRef, so the record does not need the
-- catalog edition to exist. At least one of rating or textContent must be
-- present, as the review lexicon requires.

local function valid_rating(value)
  local rating = integer_field(value)
  if rating == nil or rating < 1 or rating > 20 then
    return nil, '`rating` must be an integer between 1 and 20'
  end
  return rating
end

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local subject, err = edition_ref(input.subject)
  if err ~= nil then
    return fail(400, 'InvalidRequest', err)
  end

  local rating = nil
  if input.rating ~= nil then
    rating, err = valid_rating(input.rating)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local text = nil
  if input.textContent ~= nil then
    text = string_field(input.textContent)
    if text == nil then
      return fail(400, 'InvalidRequest', '`textContent` must be a non-empty string')
    end
  end

  if rating == nil and text == nil then
    return fail(400, 'InvalidRequest', 'a review needs a rating or a non-empty textContent')
  end

  local data = { subject = subject, createdAt = now() }
  if rating ~= nil then data.rating = rating end
  if text ~= nil then data.textContent = text end

  if input.subjectRecord ~= nil then
    local subject_record = string_field(input.subjectRecord)
    if subject_record == nil or at_uri_parts(subject_record) == nil then
      return fail(400, 'InvalidRequest', '`subjectRecord` must be an AT-URI')
    end
    data.subjectRecord = subject_record
  end

  if input.content ~= nil then
    if type(input.content) ~= 'table' then
      return fail(400, 'InvalidRequest', '`content` must be an object')
    end
    data.content = input.content
  end

  if input.flags ~= nil then
    if type(input.flags) ~= 'table' then
      return fail(400, 'InvalidRequest', '`flags` must be an object')
    end
    data.flags = input.flags
  end

  local record = Record(REVIEW_COLLECTION, data)
  record:set_rkey(TID())
  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri }
end
