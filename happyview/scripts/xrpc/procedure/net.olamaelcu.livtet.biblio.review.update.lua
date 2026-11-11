-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.review.update — edit one of the caller's reviews.
--
-- Load → mutate → save. The review lexicon has no updatedAt, so the record's
-- createdAt is the only timestamp and it is left alone.

local function valid_subject(value)
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

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local uri = string_field(input.uri)
  if uri == nil then
    return fail(400, 'InvalidRequest', '`uri` must be a review AT-URI')
  end
  local did, coll = at_uri_parts(uri)
  if did == nil or coll ~= REVIEW_COLLECTION then
    return fail(400, 'InvalidRequest', '`uri` must be an AT-URI in ' .. REVIEW_COLLECTION)
  end
  if did ~= caller_did then
    return fail(403, 'Forbidden', 'review ' .. uri .. ' belongs to another DID')
  end

  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', 'no review record at ' .. uri)
  end

  local updated = false

  if input.subject ~= nil then
    local subject, err = valid_subject(input.subject)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
    record.subject = subject
    updated = true
  end

  if input.rating ~= nil then
    local rating = integer_field(input.rating)
    if rating == nil or rating < 1 or rating > 20 then
      return fail(400, 'InvalidRequest', '`rating` must be an integer between 1 and 20')
    end
    record.rating = rating
    updated = true
  end

  if input.textContent ~= nil then
    local text = string_field(input.textContent)
    if text == nil then
      return fail(400, 'InvalidRequest', '`textContent` must be a non-empty string')
    end
    record.textContent = text
    updated = true
  end

  if input.subjectRecord ~= nil then
    local subject_record = string_field(input.subjectRecord)
    if subject_record == nil or at_uri_parts(subject_record) == nil then
      return fail(400, 'InvalidRequest', '`subjectRecord` must be an AT-URI')
    end
    record.subjectRecord = subject_record
    updated = true
  end

  if input.content ~= nil then
    if type(input.content) ~= 'table' then
      return fail(400, 'InvalidRequest', '`content` must be an object')
    end
    record.content = input.content
    updated = true
  end

  if input.flags ~= nil then
    if type(input.flags) ~= 'table' then
      return fail(400, 'InvalidRequest', '`flags` must be an object')
    end
    record.flags = input.flags
    updated = true
  end

  if record.rating == nil and record.textContent == nil then
    return fail(400, 'InvalidRequest', 'a review needs a rating or a non-empty textContent')
  end

  record:save()
  return { uri = record._uri, updated = updated }
end
