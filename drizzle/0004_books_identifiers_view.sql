-- View for searching identifiers stored in books.identifiers JSON column and claims table
CREATE VIEW IF NOT EXISTS books_identifiers AS
SELECT 
  b.uri,
  b.title,
  b.author,
  b.isbn,
  json_extract(json_each.value, '$.type') as identifier_type,
  json_extract(json_each.value, '$.value') as identifier_value,
  'json' as claim_status
FROM books b
JOIN json_each(b.identifiers) json_each
WHERE json_extract(json_each.value, '$.value') IS NOT NULL AND json_extract(json_each.value, '$.value') != ''
UNION ALL
SELECT 
  b.uri,
  b.title,
  b.author,
  b.isbn,
  c.identifierType as identifier_type,
  c.identifier as identifier_value,
  c.status as claim_status
FROM books b
JOIN claims c ON c.bookUri = b.uri;
