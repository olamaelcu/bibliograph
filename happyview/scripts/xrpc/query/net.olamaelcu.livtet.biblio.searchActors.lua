-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.searchActors — the readers a picker can name.
--
-- The index already knows which repos hold a book record: a Livtet review or
-- shelving row, a Bookhive book, a Popfeed review or shelf item. This query
-- narrows that set by what the reader typed after `@` — a handle prefix, or
-- part of a display name — and answers the accounts a mention can be written
-- for.
--
-- Handles come from `public.actor_handles`, a view the deployment owns: the
-- engine refuses script SQL against its own `happyview_linked_repos` registry
-- (that table carries scopes and session state), so the deployment exposes the
-- public half — `did` and `handle` — and nothing else. Reading through the view
-- means the handle is never stale, and the registry stays unreadable to a
-- script.
--
-- A handle match sorts before a name-only match, because a reader typing `@`
-- is writing a handle; `last_activity` breaks the tie. Display names come from
-- the reader's own Livtet profile record — the canonical
-- `net.olamaelcu.livtet.biblio.actor.profile` collection only — when the index
-- has seen one.

local MAX_QUERY = 50
local DEFAULT_LIMIT = 8
local MAX_LIMIT = 25

-- Escape the LIKE metacharacters a reader can type, so `%` and `_` in a query
-- match themselves instead of widening the search.
local function like_escape(value)
  return (value:gsub('([%%_\\])', '\\%1'))
end

function handle()
  local raw = params.q
  if type(raw) ~= 'string' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  local term = raw:match('^%s*(.-)%s*$')
  if term == '' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  if #term > MAX_QUERY then
    return fail(400, 'InvalidRequest', '`q` must be at most ' .. MAX_QUERY .. ' characters')
  end

  local limit = clamp_int(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  local needle = like_escape(term:lower())
  local handle_prefix = needle .. '%'
  local name_contains = '%' .. needle .. '%'

  -- The constants are compile-time strings, so the collection list is part of
  -- the statement rather than a parameter Postgres would have to type.
  local collections = table.concat({
    "'" .. REVIEW_COLLECTION .. "'",
    "'" .. BOOK_STATUS .. "'",
    "'" .. BOOKHIVE_BOOK .. "'",
    "'" .. POPFEED_REVIEW .. "'",
    "'" .. POPFEED_LIST_ITEM .. "'",
  }, ', ')

  local rows = db.raw(
    [[WITH readers AS (
        SELECT r.did, max(r.created_at) AS last_activity
          FROM happyview_records AS r
         WHERE r.collection IN (]] .. collections .. [[)
         GROUP BY r.did
      ),
      named AS (
        SELECT readers.did,
               readers.last_activity,
               (SELECT (profile.record::jsonb)->>'displayName'
                  FROM happyview_records AS profile
                 WHERE profile.did = readers.did
                   AND profile.collection = ']] .. PROFILE_COLLECTION .. [['
                 ORDER BY profile.created_at DESC
                 LIMIT 1) AS display_name
          FROM readers
      )
      SELECT n.did, n.display_name, h.handle
        FROM named AS n
        LEFT JOIN public.actor_handles AS h ON h.did = n.did
       WHERE lower(coalesce(h.handle, '')) LIKE $1
          OR lower(coalesce(n.display_name, '')) LIKE $2
       ORDER BY (lower(coalesce(h.handle, '')) LIKE $1) DESC,
                n.last_activity DESC,
                lower(coalesce(h.handle, n.did)) ASC
       LIMIT $3]],
    { handle_prefix, name_contains, limit }
  )

  local actors = {}
  for i = 1, #rows do
    local row = rows[i]
    local actor = { did = row.did }
    if type(row.handle) == 'string' and row.handle ~= '' then
      actor.handle = row.handle
    end
    if type(row.display_name) == 'string' and row.display_name ~= '' then
      actor.displayName = row.display_name
    end
    actors[#actors + 1] = actor
  end
  return { actors = toarray(actors) }
end
