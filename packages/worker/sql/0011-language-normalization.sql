-- 0011-language-normalization.sql
--
-- One spelling per language in the claim table.
--
-- Providers supply ISO 639-2 codes, because that is how OpenLibrary keys
-- `/languages/…` (`eng`, `fre`, `ger`), while curation writes BCP 47 (`en`,
-- `en-US`). The same language therefore had two spellings, so the catalog's
-- `searchEditions` language filter matched only half of it, and a reader saw one
-- language under two labels. This file keeps the two-letter ISO 639-1 code
-- wherever one exists, case-folded in its primary subtag, with any region
-- suffix preserved (`eng-US` → `en-US`).
--
-- The alias table is derived, not hand-written: it is every three-letter code
-- ICU (`new Intl.Locale(code).language`) canonicalises to a two-letter one, so
-- it carries the ISO 639-2 bibliographic and terminology forms alike (`fre` and
-- `fra` both → `fr`). Regenerate it rather than editing entries.
--
-- Normalization runs in a BEFORE trigger on the claim table, so ingest, the
-- admin editor and any later writer agree without each carrying a copy of the
-- list; the backfill at the end is what brings existing rows into line. Applying
-- the file again is a no-op: the seed is `ON CONFLICT DO NOTHING`, the function
-- and trigger are replaced, and the UPDATE converges to zero rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- Alias table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS language_aliases (
  alias text PRIMARY KEY,
  language text NOT NULL
);

INSERT INTO language_aliases (alias, language) VALUES
  ('aar', 'aa'), ('abk', 'ab'), ('adp', 'dz'), ('afr', 'af'), ('aka', 'ak'), ('alb', 'sq'), ('als', 'sq'), ('amh', 'am'),
  ('ara', 'ar'), ('arb', 'ar'), ('arg', 'an'), ('arm', 'hy'), ('asm', 'as'), ('ava', 'av'), ('ave', 'ae'), ('aym', 'ay'),
  ('ayr', 'ay'), ('aze', 'az'), ('azj', 'az'), ('bak', 'ba'), ('bam', 'bm'), ('baq', 'eu'), ('bel', 'be'), ('ben', 'bn'),
  ('bis', 'bi'), ('bod', 'bo'), ('bos', 'bs'), ('bre', 'br'), ('bul', 'bg'), ('bur', 'my'), ('cat', 'ca'), ('ces', 'cs'),
  ('cha', 'ch'), ('che', 'ce'), ('chi', 'zh'), ('chu', 'cu'), ('chv', 'cv'), ('cls', 'sa'), ('cmn', 'zh'), ('cnr', 'sr'),
  ('cor', 'kw'), ('cos', 'co'), ('cre', 'cr'), ('cwd', 'cr'), ('cym', 'cy'), ('cze', 'cs'), ('dan', 'da'), ('deu', 'de'),
  ('div', 'dv'), ('drh', 'mn'), ('drw', 'fa'), ('dut', 'nl'), ('dzo', 'dz'), ('ekk', 'et'), ('ell', 'el'), ('eng', 'en'),
  ('epo', 'eo'), ('esk', 'ik'), ('est', 'et'), ('eus', 'eu'), ('ewe', 'ee'), ('fao', 'fo'), ('fas', 'fa'), ('fat', 'ak'),
  ('fij', 'fj'), ('fin', 'fi'), ('fra', 'fr'), ('fre', 'fr'), ('fry', 'fy'), ('fuc', 'ff'), ('ful', 'ff'), ('gaz', 'om'),
  ('geo', 'ka'), ('ger', 'de'), ('gla', 'gd'), ('gle', 'ga'), ('glg', 'gl'), ('glv', 'gv'), ('gre', 'el'), ('grn', 'gn'),
  ('gug', 'gn'), ('guj', 'gu'), ('hat', 'ht'), ('hau', 'ha'), ('hbs', 'sr'), ('heb', 'he'), ('her', 'hz'), ('hin', 'hi'),
  ('hmo', 'ho'), ('hrv', 'hr'), ('hun', 'hu'), ('hye', 'hy'), ('ibo', 'ig'), ('ice', 'is'), ('ido', 'io'), ('iii', 'ii'),
  ('ike', 'iu'), ('iku', 'iu'), ('ile', 'ie'), ('ina', 'ia'), ('ind', 'id'), ('ipk', 'ik'), ('isl', 'is'), ('ita', 'it'),
  ('jav', 'jv'), ('jaw', 'jv'), ('jpn', 'ja'), ('kal', 'kl'), ('kan', 'kn'), ('kas', 'ks'), ('kat', 'ka'), ('kau', 'kr'),
  ('kaz', 'kk'), ('khk', 'mn'), ('khm', 'km'), ('kik', 'ki'), ('kin', 'rw'), ('kir', 'ky'), ('kmr', 'ku'), ('knc', 'kr'),
  ('kng', 'kg'), ('kom', 'kv'), ('kon', 'kg'), ('kor', 'ko'), ('kpv', 'kv'), ('kua', 'kj'), ('kur', 'ku'), ('lao', 'lo'),
  ('lat', 'la'), ('lav', 'lv'), ('lim', 'li'), ('lin', 'ln'), ('lit', 'lt'), ('ltz', 'lb'), ('lub', 'lu'), ('lug', 'lg'),
  ('lvs', 'lv'), ('mac', 'mk'), ('mah', 'mh'), ('mal', 'ml'), ('mao', 'mi'), ('mar', 'mr'), ('may', 'ms'), ('mkd', 'mk'),
  ('mlg', 'mg'), ('mlt', 'mt'), ('mol', 'ro'), ('mon', 'mn'), ('mri', 'mi'), ('msa', 'ms'), ('mya', 'my'), ('nau', 'na'),
  ('nav', 'nv'), ('nbl', 'nr'), ('nde', 'nd'), ('ndo', 'ng'), ('nep', 'ne'), ('nld', 'nl'), ('nno', 'nn'), ('nob', 'nb'),
  ('nor', 'no'), ('npi', 'ne'), ('nya', 'ny'), ('oci', 'oc'), ('ojg', 'oj'), ('oji', 'oj'), ('ori', 'or'), ('orm', 'om'),
  ('ory', 'or'), ('oss', 'os'), ('pan', 'pa'), ('pbu', 'ps'), ('per', 'fa'), ('pes', 'fa'), ('pli', 'pi'), ('plt', 'mg'),
  ('pol', 'pl'), ('por', 'pt'), ('prp', 'gu'), ('prs', 'fa'), ('pus', 'ps'), ('que', 'qu'), ('quz', 'qu'), ('roh', 'rm'),
  ('ron', 'ro'), ('rum', 'ro'), ('run', 'rn'), ('rus', 'ru'), ('sag', 'sg'), ('san', 'sa'), ('scc', 'sr'), ('scr', 'hr'),
  ('sin', 'si'), ('slk', 'sk'), ('slo', 'sk'), ('slv', 'sl'), ('sme', 'se'), ('smo', 'sm'), ('sna', 'sn'), ('snd', 'sd'),
  ('som', 'so'), ('sot', 'st'), ('spa', 'es'), ('sqi', 'sq'), ('src', 'sc'), ('srd', 'sc'), ('srp', 'sr'), ('ssw', 'ss'),
  ('sun', 'su'), ('swa', 'sw'), ('swc', 'sw'), ('swe', 'sv'), ('swh', 'sw'), ('tah', 'ty'), ('tam', 'ta'), ('tat', 'tt'),
  ('tel', 'te'), ('tgk', 'tg'), ('tha', 'th'), ('tib', 'bo'), ('tir', 'ti'), ('tnf', 'fa'), ('ton', 'to'), ('tsn', 'tn'),
  ('tso', 'ts'), ('tuk', 'tk'), ('tur', 'tr'), ('twi', 'ak'), ('uig', 'ug'), ('ukr', 'uk'), ('urd', 'ur'), ('uzb', 'uz'),
  ('uzn', 'uz'), ('ven', 've'), ('vie', 'vi'), ('vol', 'vo'), ('wel', 'cy'), ('wln', 'wa'), ('wol', 'wo'), ('xho', 'xh'),
  ('ydd', 'yi'), ('yid', 'yi'), ('yor', 'yo'), ('zha', 'za'), ('zho', 'zh'), ('zsm', 'ms'), ('zul', 'zu'), ('zyb', 'za')
ON CONFLICT (alias) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Canonical form
--
-- A canonical primary subtag: `en` stays `en`, `eng` becomes `en`, `eng-US`
-- becomes `en-US`. A code the table does not know is only trimmed and
-- lowercased, so the column stays consistent for it; an empty value becomes
-- NULL rather than an empty claim.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION normalize_language(value text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  cleaned text;
  head text;
  suffix text := '';
  mapped text;
BEGIN
  cleaned := btrim(coalesce(value, ''));
  IF cleaned = '' THEN
    RETURN NULL;
  END IF;

  head := split_part(cleaned, '-', 1);
  IF cleaned <> head THEN
    suffix := substr(cleaned, length(head) + 1);
  END IF;

  SELECT language INTO mapped FROM language_aliases WHERE alias = lower(head);
  RETURN coalesce(mapped, lower(head)) || suffix;
END;
$function$;

CREATE OR REPLACE FUNCTION normalize_identifier_language()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.language := normalize_language(NEW.language);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER normalize_identifier_language
  BEFORE INSERT OR UPDATE OF language ON edition_identifier_info
  FOR EACH ROW EXECUTE FUNCTION normalize_identifier_language();

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Every edition already carries its language per identifier, so this rewrites
-- the stored values in place; no other row is touched.
-- ---------------------------------------------------------------------------

UPDATE edition_identifier_info
   SET language = normalize_language(language)
 WHERE language IS DISTINCT FROM normalize_language(language);

COMMIT;
