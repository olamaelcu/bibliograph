-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.readingGoal.set — set the reading goal.
--
-- The readingGoal record lives at the literal rkey 'current'; the
-- getReadingGoal query reads that key, so this is a single-record upsert.

local PERIODS = { weekly = true, monthly = true, annual = true }

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local period = string_field(input.period)
  if period == nil or not PERIODS[period] then
    return fail(400, 'InvalidRequest', '`period` must be one of weekly, monthly, annual')
  end

  local year = integer_field(input.year)
  if year == nil or year < 1900 or year > 9999 then
    return fail(400, 'InvalidRequest', '`year` must be an integer between 1900 and 9999')
  end

  local books_goal = integer_field(input.booksGoal)
  if books_goal == nil or books_goal < 1 then
    return fail(400, 'InvalidRequest', '`booksGoal` must be an integer of at least 1')
  end

  local stamp = now()
  local uri = 'at://' .. caller_did .. '/' .. READING_GOAL .. '/current'
  local record = Record.load(uri)

  if record ~= nil then
    record.period = period
    record.year = year
    record.booksGoal = books_goal
    record.updatedAt = stamp
  else
    record = Record(READING_GOAL, {
      period = period,
      year = year,
      booksGoal = books_goal,
      createdAt = stamp,
      updatedAt = stamp,
    })
    record:set_rkey('current')
  end

  local failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri, period = period, year = year, booksGoal = books_goal }
end
