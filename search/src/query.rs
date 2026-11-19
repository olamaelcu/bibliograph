//! Query construction and collection.
//!
//! The mapping mirrors the Postgres surface: free text is an AND of terms,
//! each term matching any of the five text fields with per-field boosts; the
//! `title`/`author` hints are phrase-prefix matches on one field so that
//! "Frank Herber" still finds "Frank Herbert"; `language` is an exact term on
//! the primary subtag; sorting is relevance, title (case-insensitive) or
//! published year with unknown years last in both directions.

use serde::{Deserialize, Serialize};
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{AllQuery, BooleanQuery, BoostQuery, Occur, PhrasePrefixQuery, Query, TermQuery};
use tantivy::schema::{IndexRecordOption, OwnedValue, TantivyDocument};
use tantivy::tokenizer::{TextAnalyzer, TokenizerManager};
use tantivy::{DocAddress, Order, Searcher, Term};

use crate::index::Engine;
use crate::schema::{primary_subtag, Fields, TEXT_BOOSTS};

const MAX_TERMS: usize = 16;
const MAX_EXPANSIONS: u32 = 50;
const MAX_LIMIT: usize = 100;
const MAX_OFFSET: usize = 10_000;
const MAX_TYPEAHEAD_TERMS: usize = 8;
const MAX_TYPEAHEAD_EXPANSIONS: u32 = 128;
const MAX_TYPEAHEAD_LIMIT: usize = 25;
const DEFAULT_TYPEAHEAD_LIMIT: usize = 8;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub uris: Vec<String>,
    pub has_more: bool,
    pub total: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TypeaheadRequest {
    pub q: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct TypeaheadResponse {
    pub uris: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sort {
    Relevance,
    Title(Order),
    Year(Order),
}

fn sort_of(req: &SearchRequest) -> Result<Sort, String> {
    let order = match req.order.as_deref().unwrap_or("asc") {
        "asc" => Order::Asc,
        "desc" => Order::Desc,
        other => return Err(format!("order must be asc or desc, not {other:?}")),
    };
    match req.sort.as_deref().unwrap_or("relevance") {
        "relevance" => Ok(Sort::Relevance),
        "title" => Ok(Sort::Title(order)),
        "publishedYear" => Ok(Sort::Year(order)),
        other => Err(format!(
            "sort must be relevance, title or publishedYear, not {other:?}"
        )),
    }
}

fn analyzer() -> TextAnalyzer {
    TokenizerManager::default()
        .get("en_stem")
        .expect("the en_stem tokenizer ships with tantivy")
}

/// Analyse `text` and return its distinct terms, bounded.
fn terms(analyzer: &mut TextAnalyzer, text: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stream = analyzer.token_stream(text);
    while stream.advance() {
        let token = stream.token().text.clone();
        if !token.is_empty() && !out.contains(&token) {
            out.push(token);
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

fn term_clause(fields: &Fields, term: &str) -> Box<dyn Query> {
    let mut any = Vec::with_capacity(TEXT_BOOSTS.len());
    for (name, boost) in TEXT_BOOSTS {
        let field = fields
            .text_field(name)
            .expect("TEXT_BOOSTS names only text fields");
        let term_query = TermQuery::new(
            Term::from_field_text(field, term),
            IndexRecordOption::WithFreqs,
        );
        any.push((
            Occur::Should,
            Box::new(BoostQuery::new(Box::new(term_query), boost)) as Box<dyn Query>,
        ));
    }
    Box::new(BooleanQuery::new(any))
}

fn phrase_prefix(field: tantivy::schema::Field, analyzer: &mut TextAnalyzer, text: &str) -> Option<Box<dyn Query>> {
    let tokens = terms(analyzer, text, MAX_TERMS);
    if tokens.is_empty() {
        return None;
    }
    let mut query = PhrasePrefixQuery::new(
        tokens
            .iter()
            .map(|token| Term::from_field_text(field, token))
            .collect(),
    );
    query.set_max_expansions(MAX_EXPANSIONS);
    Some(Box::new(query))
}

fn build_query(engine: &Engine, req: &SearchRequest) -> Result<Box<dyn Query>, String> {
    let fields = &engine.fields;
    let mut analyzer = analyzer();
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();

    if let Some(q) = req.q.as_deref().filter(|q| !q.trim().is_empty()) {
        for term in terms(&mut analyzer, q, MAX_TERMS) {
            // Each term must appear (AND over terms), in any field (OR over
            // fields). A term is a single analysed token, so no quoting.
            clauses.push((Occur::Must, term_clause(fields, &term)));
        }
    }
    if let Some(title) = req.title.as_deref().filter(|t| !t.trim().is_empty()) {
        if let Some(clause) = phrase_prefix(fields.title, &mut analyzer, title) {
            clauses.push((Occur::Must, clause));
        }
    }
    if let Some(author) = req.author.as_deref().filter(|a| !a.trim().is_empty()) {
        if let Some(clause) = phrase_prefix(fields.contributors, &mut analyzer, author) {
            clauses.push((Occur::Must, clause));
        }
    }
    if let Some(language) = req.language.as_deref().filter(|l| !l.trim().is_empty()) {
        clauses.push((
            Occur::Must,
            Box::new(TermQuery::new(
                Term::from_field_text(fields.language, &primary_subtag(language)),
                IndexRecordOption::Basic,
            )),
        ));
    }

    Ok(if clauses.is_empty() {
        Box::new(AllQuery)
    } else {
        Box::new(BooleanQuery::new(clauses))
    })
}

/// A single token matched as a prefix, expanded over the field's term dictionary.
fn prefix_clause(field: tantivy::schema::Field, token: &str) -> Box<dyn Query> {
    let mut query = PhrasePrefixQuery::new(vec![Term::from_field_text(field, token)]);
    query.set_max_expansions(MAX_TYPEAHEAD_EXPANSIONS);
    Box::new(query)
}

/// One typed token must complete the title, the subtitle or a contributor name.
/// Prose fields stay out: a prefix there matches nearly everything.
fn typeahead_token_clause(fields: &Fields, token: &str) -> Box<dyn Query> {
    let any = [(fields.title, 4.0), (fields.subtitle, 2.0), (fields.contributors, 2.0)]
        .into_iter()
        .map(|(field, boost)| {
            (
                Occur::Should,
                Box::new(BoostQuery::new(prefix_clause(field, token), boost)) as Box<dyn Query>,
            )
        })
        .collect();
    Box::new(BooleanQuery::new(any))
}

fn collect_uris<I>(searcher: &Searcher, uri: tantivy::schema::Field, addrs: I) -> Result<Vec<String>, String>
where
    I: Iterator<Item = DocAddress>,
{
    let mut uris = Vec::new();
    for addr in addrs {
        let doc: TantivyDocument = searcher.doc(addr).map_err(|e| format!("read doc: {e}"))?;
        let value = match doc.get_first(uri).map(OwnedValue::from) {
            Some(OwnedValue::Str(value)) => value,
            _ => return Err("stored document has no uri".to_string()),
        };
        uris.push(value);
    }
    Ok(uris)
}

pub fn search(engine: &Engine, req: &SearchRequest) -> Result<SearchResponse, String> {
    let searcher = engine.searcher();
    let query = build_query(engine, req)?;
    let limit = req.limit.unwrap_or(25).clamp(1, MAX_LIMIT);
    let offset = req.offset.unwrap_or(0).min(MAX_OFFSET);
    // One extra hit tells `hasMore` without a second query.
    let window = limit + 1;

    let (uris, has_more, total) = match sort_of(req)? {
        Sort::Relevance => {
            let (top, total) = searcher
                .search(
                    &query,
                    &(
                        TopDocs::with_limit(window).and_offset(offset).order_by_score(),
                        Count,
                    ),
                )
                .map_err(|e| format!("search: {e}"))?;
            let has_more = top.len() > limit;
            let uris = collect_uris(
                &searcher,
                engine.fields.uri,
                top.into_iter().take(limit).map(|(_, addr)| addr),
            )?;
            (uris, has_more, total)
        }
        Sort::Title(order) => {
            let (top, total) = searcher
                .search(
                    &query,
                    &(
                        TopDocs::with_limit(window)
                            .and_offset(offset)
                            .order_by_string_fast_field("title_sort", order),
                        Count,
                    ),
                )
                .map_err(|e| format!("search: {e}"))?;
            let has_more = top.len() > limit;
            let uris = collect_uris(
                &searcher,
                engine.fields.uri,
                top.into_iter().take(limit).map(|(_, addr)| addr),
            )?;
            (uris, has_more, total)
        }
        Sort::Year(order) => {
            // Oldest-first sorts ascending on `year_asc`; newest-first sorts
            // *ascending* on the complemented `year_desc` (MAX - year). Both
            // store `u64::MAX` for a missing year, so unknown is last in both
            // directions.
            let field = if order == Order::Asc {
                "year_asc"
            } else {
                "year_desc"
            };
            let (top, total) = searcher
                .search(
                    &query,
                    &(
                        TopDocs::with_limit(window)
                            .and_offset(offset)
                            .order_by_u64_field(field, Order::Asc),
                        Count,
                    ),
                )
                .map_err(|e| format!("search: {e}"))?;
            let has_more = top.len() > limit;
            let uris = collect_uris(
                &searcher,
                engine.fields.uri,
                top.into_iter().take(limit).map(|(_, addr)| addr),
            )?;
            (uris, has_more, total)
        }
    };

    Ok(SearchResponse {
        uris,
        has_more,
        total,
    })
}

/// Prefix completion: every token must complete one of title, subtitle or a
/// contributor name; ranking is the same relevance score as free text.
pub fn typeahead(engine: &Engine, req: &TypeaheadRequest) -> Result<TypeaheadResponse, String> {
    let q = req.q.trim();
    if q.chars().count() < 2 {
        return Ok(TypeaheadResponse { uris: Vec::new() });
    }
    let mut analyzer = analyzer();
    let tokens = terms(&mut analyzer, q, MAX_TYPEAHEAD_TERMS);
    if tokens.is_empty() {
        return Ok(TypeaheadResponse { uris: Vec::new() });
    }
    let clauses: Vec<(Occur, Box<dyn Query>)> = tokens
        .iter()
        .map(|token| (Occur::Must, typeahead_token_clause(&engine.fields, token)))
        .collect();
    let query = BooleanQuery::new(clauses);
    let limit = req
        .limit
        .unwrap_or(DEFAULT_TYPEAHEAD_LIMIT)
        .clamp(1, MAX_TYPEAHEAD_LIMIT);
    let searcher = engine.searcher();
    let top = searcher
        .search(&query, &TopDocs::with_limit(limit).order_by_score())
        .map_err(|e| format!("typeahead search: {e}"))?;
    let uris = collect_uris(
        &searcher,
        engine.fields.uri,
        top.into_iter().map(|(_, addr)| addr),
    )?;
    Ok(TypeaheadResponse { uris })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{DocsRequest, Engine};
    use crate::schema::Doc;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tempdir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("bibsearch-{}-{nanos}-{n}", std::process::id()))
    }

    fn doc(uri: &str, title: &str, authors: &[&str], year: Option<u32>, language: Option<&str>) -> Doc {
        Doc {
            uri: uri.into(),
            title: Some(title.into()),
            contributors: authors.iter().map(|a| a.to_string()).collect(),
            year,
            language: language.map(str::to_owned),
            description: Some(format!("a book called {title}")),
            ..Doc::default()
        }
    }

    fn engine() -> Engine {
        let dir = tempdir();
        let engine = Engine::open(&dir).expect("open index");
        engine
            .apply(DocsRequest {
                upsert: vec![
                    doc("at://dune", "Dune", &["Frank Herbert"], Some(1965), Some("en")),
                    doc("at://messiah", "Dune Messiah", &["Frank Herbert"], Some(1969), Some("en-US")),
                    doc("at://emma", "Emma", &["Jane Austen"], Some(1815), Some("eng")),
                    doc("at://undated", "Dune Encyclopedia", &["Willis E. McNelly"], None, Some("en")),
                ],
                delete: vec![],
            })
            .expect("index docs");
        engine
    }

    fn req(q: &str) -> SearchRequest {
        SearchRequest {
            q: Some(q.into()),
            ..SearchRequest::default()
        }
    }

    #[test]
    fn free_text_matches_every_dune() {
        let engine = engine();
        let out = engine.search(&req("dune")).unwrap();
        assert_eq!(out.total, 3);
        assert!(!out.has_more);
        assert_eq!(out.uris.len(), 3);
    }

    #[test]
    fn terms_are_anded() {
        let engine = engine();
        let out = engine.search(&req("dune herbert")).unwrap();
        assert_eq!(out.total, 2);
    }

    #[test]
    fn title_prefix_matches_a_partial_word() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                title: Some("Mess".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris, vec!["at://messiah"]);
    }

    #[test]
    fn author_prefix_matches_a_partial_name() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                author: Some("Frank Herber".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.total, 2);
    }

    #[test]
    fn language_filter_uses_the_primary_subtag() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                language: Some("en-US".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        // `en` matches en and en-US documents.
        assert_eq!(out.total, 3);
    }

    #[test]
    fn year_desc_puts_newest_first_and_unknown_last() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                sort: Some("publishedYear".into()),
                order: Some("desc".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris, vec!["at://messiah", "at://dune", "at://undated"]);
    }

    #[test]
    fn year_asc_puts_oldest_first_and_unknown_last() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                sort: Some("publishedYear".into()),
                order: Some("asc".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris, vec!["at://dune", "at://messiah", "at://undated"]);
    }

    #[test]
    fn title_sort_is_case_insensitive() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                sort: Some("title".into()),
                order: Some("asc".into()),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris[0], "at://dune");
    }

    #[test]
    fn offset_and_has_more() {
        let engine = engine();
        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                limit: Some(2),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris.len(), 2);
        assert!(out.has_more);
        assert_eq!(out.total, 3);

        let out = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                limit: Some(2),
                offset: Some(2),
                ..SearchRequest::default()
            })
            .unwrap();
        assert_eq!(out.uris.len(), 1);
        assert!(!out.has_more);
    }

    #[test]
    fn upsert_replaces_and_delete_removes() {
        let engine = engine();
        engine
            .apply(DocsRequest {
                upsert: vec![doc("at://dune", "Dune (Second Edition)", &["Frank Herbert"], Some(1965), Some("en"))],
                delete: vec!["at://emma".into()],
            })
            .unwrap();
        assert_eq!(engine.health().docs, 3);
        let out = engine.search(&req("emma")).unwrap();
        assert_eq!(out.total, 0);
        let out = engine.search(&req("second")).unwrap();
        assert_eq!(out.uris, vec!["at://dune"]);
    }

    #[test]
    fn unknown_sort_is_rejected() {
        let engine = engine();
        let err = engine
            .search(&SearchRequest {
                q: Some("dune".into()),
                sort: Some("price".into()),
                ..SearchRequest::default()
            })
            .unwrap_err();
        assert!(err.contains("sort must be"));
    }

    fn typeahead_req(q: &str, limit: Option<usize>) -> TypeaheadRequest {
        TypeaheadRequest { q: q.into(), limit }
    }

    fn sorted(uris: Vec<String>) -> Vec<String> {
        let mut uris = uris;
        uris.sort();
        uris
    }

    #[test]
    fn typeahead_matches_title_prefix() {
        let engine = engine();
        let out = engine.typeahead(&typeahead_req("du", None)).unwrap();
        assert_eq!(
            sorted(out.uris),
            vec!["at://dune", "at://messiah", "at://undated"]
        );
    }

    #[test]
    fn typeahead_matches_author_prefix() {
        let engine = engine();
        let out = engine.typeahead(&typeahead_req("herb", None)).unwrap();
        assert_eq!(sorted(out.uris), vec!["at://dune", "at://messiah"]);
    }

    #[test]
    fn typeahead_spans_title_and_author() {
        let engine = engine();
        let out = engine.typeahead(&typeahead_req("dune her", None)).unwrap();
        assert_eq!(sorted(out.uris), vec!["at://dune", "at://messiah"]);
    }

    #[test]
    fn typeahead_limit_is_clamped() {
        let engine = engine();
        let out = engine.typeahead(&typeahead_req("dune", Some(1))).unwrap();
        assert_eq!(out.uris.len(), 1);
        let out = engine.typeahead(&typeahead_req("dune", Some(0))).unwrap();
        assert_eq!(out.uris.len(), 1);
        let out = engine.typeahead(&typeahead_req("dune", Some(999))).unwrap();
        assert_eq!(out.uris.len(), 3);
    }

    #[test]
    fn typeahead_short_or_blank_query_is_empty() {
        let engine = engine();
        for q in ["d", "  ", "!!!"] {
            let out = engine.typeahead(&typeahead_req(q, None)).unwrap();
            assert!(out.uris.is_empty(), "{q:?} should not match");
        }
    }

    #[test]
    fn typeahead_unknown_prefix_is_empty() {
        let engine = engine();
        let out = engine.typeahead(&typeahead_req("zzz", None)).unwrap();
        assert!(out.uris.is_empty());
    }
}
