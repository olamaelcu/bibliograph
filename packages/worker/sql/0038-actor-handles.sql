-- A reader's handle, for scripts that must name an account.
--
-- `happyview_linked_repos` is the engine's own registry — it records scopes,
-- sessions and refresh state next to the handle — and the engine refuses a
-- script that reads it (`db.raw cannot reference the protected internal
-- HappyView table`). That refusal is correct: a lookup script has no business
-- with an account's auth state.
--
-- What a script does legitimately need is the public half: which handle a DID
-- answers to, so a mention picker can complete `@jacky` without the caller
-- resolving every row one HTTP request at a time. This view is that half, and
-- nothing else: two columns, no scopes, no tokens, no timestamps.
--
-- A view rather than a mirrored table on purpose. A table would need a job to
-- keep it true, and a stale handle is worse than no handle: the picker would
-- write `@old-name` into a record. Reading the registry through the view means
-- the answer is the registry's, always.
--
-- `happyview_app` (the AppView's role) gets SELECT; the view runs with the
-- owner's rights, so the registry itself stays unreadable to the engine role.
--
-- Handles are public identity, not personal data: every one of them is already
-- resolvable through the PLC directory by anyone holding the DID.
CREATE OR REPLACE VIEW public.actor_handles AS
SELECT DID,
       btrim(handle) AS handle
  FROM happyview.happyview_linked_repos
 WHERE handle IS NOT NULL
   AND btrim(handle) <> '';

COMMENT ON VIEW public.actor_handles IS
  'The public half of happyview_linked_repos (did, handle), readable by AppView scripts.';

GRANT SELECT ON public.actor_handles TO happyview_app;
