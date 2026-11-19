//! Document shape and index schema.
//!
//! The document is derived from Postgres (`books` plus its children); nothing
//! here is a source of truth. `year` is indexed twice so "unknown year sorts
//! last" holds in both directions: `year_asc` is the year, `year_desc` is
//! `u64::MAX - year`, and a missing year is `u64::MAX` in both fields.

use serde::{Deserialize, Serialize};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, FAST, STRING,
};

/// One catalog document as the worker posts it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub uri: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Contributor display names, already flattened by the caller.
    #[serde(default)]
    pub contributors: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub year: Option<u32>,
}

/// The fields every query refers to, resolved once at startup.
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub uri: Field,
    pub title: Field,
    pub subtitle: Field,
    pub contributors: Field,
    pub description: Field,
    pub genres: Field,
    pub language: Field,
    pub title_sort: Field,
    pub year_asc: Field,
    pub year_desc: Field,
}

/// Free-text fields and their boosts, in the order used by the query builder.
pub const TEXT_BOOSTS: [(&str, f32); 5] = [
    ("title", 4.0),
    ("subtitle", 2.0),
    ("contributors", 2.0),
    ("description", 1.0),
    ("genres", 1.0),
];

fn text(tokenizer: &str, positions: bool, stored: bool) -> TextOptions {
    let record = if positions {
        IndexRecordOption::WithFreqsAndPositions
    } else {
        IndexRecordOption::WithFreqs
    };
    let options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(tokenizer)
                .set_index_option(record),
        );
    if stored {
        options.set_stored()
    } else {
        options
    }
}

/// Build the schema and resolve the fields.
pub fn build() -> (Schema, Fields) {
    let mut b = Schema::builder();
    // Only the uri is stored: hydration happens in Postgres from the uris the
    // engine returns, so the other fields cost nothing on disk beyond the index.
    let uri = b.add_text_field("uri", STRING.set_stored());
    let title = b.add_text_field("title", text("en_stem", true, false));
    let subtitle = b.add_text_field("subtitle", text("en_stem", true, false));
    let contributors = b.add_text_field("contributors", text("en_stem", true, false));
    let description = b.add_text_field("description", text("en_stem", false, false));
    let genres = b.add_text_field("genres", text("en_stem", false, false));
    // Language is filtered by exact term on the primary subtag.
    let language = b.add_text_field("language", text("raw", false, false));
    // Sorting keys: string sort is case-insensitive by pre-lowering the value.
    let title_sort = b.add_text_field("title_sort", TextOptions::default().set_fast(Some("raw")));
    let year_asc = b.add_u64_field("year_asc", FAST);
    let year_desc = b.add_u64_field("year_desc", FAST);
    (
        b.build(),
        Fields {
            uri,
            title,
            subtitle,
            contributors,
            description,
            genres,
            language,
            title_sort,
            year_asc,
            year_desc,
        },
    )
}

/// `en-US` → `en`; the catalog filters on the primary subtag.
pub fn primary_subtag(language: &str) -> String {
    language
        .split('-')
        .next()
        .unwrap_or(language)
        .to_ascii_lowercase()
}

impl Fields {
    pub fn document(&self, d: &Doc) -> TantivyDocument {
        let mut doc = TantivyDocument::default();
        doc.add_text(self.uri, &d.uri);
        if let Some(title) = d.title.as_deref().filter(|t| !t.is_empty()) {
            doc.add_text(self.title, title);
            doc.add_text(self.title_sort, title.to_lowercase());
        }
        if let Some(subtitle) = d.subtitle.as_deref().filter(|t| !t.is_empty()) {
            doc.add_text(self.subtitle, subtitle);
        }
        if !d.contributors.is_empty() {
            doc.add_text(self.contributors, d.contributors.join(" "));
        }
        if let Some(description) = d.description.as_deref().filter(|t| !t.is_empty()) {
            doc.add_text(self.description, description);
        }
        if !d.genres.is_empty() {
            doc.add_text(self.genres, d.genres.join(" "));
        }
        if let Some(language) = d.language.as_deref().filter(|l| !l.is_empty()) {
            doc.add_text(self.language, primary_subtag(language));
        }
        let year = d.year.map(u64::from);
        doc.add_u64(self.year_asc, year.unwrap_or(u64::MAX));
        doc.add_u64(self.year_desc, year.map(|y| u64::MAX - y).unwrap_or(u64::MAX));
        doc
    }

    pub fn text_field(&self, name: &str) -> Option<Field> {
        Some(match name {
            "title" => self.title,
            "subtitle" => self.subtitle,
            "contributors" => self.contributors,
            "description" => self.description,
            "genres" => self.genres,
            _ => return None,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct Health {
    pub status: &'static str,
    pub docs: u64,
    pub segments: usize,
}
