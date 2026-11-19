//! Engine state: one writer (the only process that may hold the lock), a
//! reader that reloads on commit, and the request handlers on top of both.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy};

use crate::query::{search, SearchRequest, SearchResponse};
use crate::schema::{self, Doc, Fields, Health};

const WRITER_HEAP_BYTES: usize = 128 * 1024 * 1024;
const WRITER_THREADS: usize = 2;

pub struct Engine {
    pub fields: Fields,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
}

#[derive(Debug, Deserialize)]
pub struct DocsRequest {
    #[serde(default)]
    pub upsert: Vec<Doc>,
    #[serde(default)]
    pub delete: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DocsResponse {
    pub upserts: usize,
    pub deletes: usize,
    pub docs: u64,
}

impl Engine {
    /// Open an existing index, or create an empty one in `dir`.
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {dir:?}: {e}"))?;
        let (schema, fields) = schema::build();
        let index = if dir.join("meta.json").exists() {
            Index::open_in_dir(dir).map_err(|e| format!("open {dir:?}: {e}"))?
        } else {
            Index::create_in_dir(dir, schema.clone()).map_err(|e| format!("create {dir:?}: {e}"))?
        };
        // A different schema on disk is a rebuild, not a silent mismatch.
        if index.schema() != schema {
            return Err(format!(
                "index at {dir:?} was built with a different schema; rebuild it"
            ));
        }
        let writer = index
            .writer_with_num_threads::<tantivy::TantivyDocument>(WRITER_THREADS, WRITER_HEAP_BYTES)
            .map_err(|e| format!("writer: {e}"))?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| format!("reader: {e}"))?;
        Ok(Self {
            fields,
            reader,
            writer: Mutex::new(writer),
        })
    }

    pub fn apply(&self, req: DocsRequest) -> Result<DocsResponse, String> {
        let mut writer = self.writer.lock().map_err(|_| "writer poisoned".to_string())?;
        for uri in &req.delete {
            writer.delete_term(tantivy::Term::from_field_text(self.fields.uri, uri));
        }
        for doc in &req.upsert {
            // Upsert by uri: delete then add, so a re-posted document replaces
            // the previous revision instead of duplicating it.
            writer.delete_term(tantivy::Term::from_field_text(self.fields.uri, &doc.uri));
            writer
                .add_document(self.fields.document(doc))
                .map_err(|e| format!("add {}: {e}", doc.uri))?;
        }
        // One commit per batch keeps a segment per post; the merge policy
        // collapses them in the background.
        let committed = std::time::Instant::now();
        writer.commit().map_err(|e| format!("commit: {e}"))?;
        metrics::histogram!("search_commit_duration_seconds")
            .record(committed.elapsed().as_secs_f64());
        // `ReloadPolicy::OnCommitWithDelay` polls for a new commit; reloading
        // here makes a posted batch visible before the response is sent, which
        // is what the backfill and the cron drain rely on.
        self.reader
            .reload()
            .map_err(|e| format!("reload reader: {e}"))?;
        Ok(DocsResponse {
            upserts: req.upsert.len(),
            deletes: req.delete.len(),
            docs: self.reader.searcher().num_docs(),
        })
    }

    pub fn search(&self, req: &SearchRequest) -> Result<SearchResponse, String> {
        search(self, req)
    }

    pub fn health(&self) -> Health {
        let searcher = self.reader.searcher();
        Health {
            status: "ok",
            docs: searcher.num_docs(),
            segments: searcher.segment_readers().len(),
        }
    }

    pub(crate) fn searcher(&self) -> tantivy::Searcher {
        self.reader.searcher()
    }
}
