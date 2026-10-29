ALTER TABLE "contributors" ADD CONSTRAINT "contributors_name_non_empty" CHECK (btrim("name") <> '');
