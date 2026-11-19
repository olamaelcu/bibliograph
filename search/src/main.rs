mod http;
mod index;
mod query;
mod schema;

use std::path::PathBuf;
use std::sync::Arc;

use index::Engine;

const DEFAULT_BIND: &str = "127.0.0.1:3103";
const DEFAULT_INDEX_DIR: &str = "/var/lib/bibliograph-search/index";

fn usage() -> ! {
    eprintln!(
        "usage: bibliograph-search [--index-dir DIR] [--bind HOST:PORT]\n\
         defaults: --index-dir {} --bind {} (env: SEARCH_INDEX_DIR, SEARCH_BIND)",
        DEFAULT_INDEX_DIR, DEFAULT_BIND
    );
    std::process::exit(2)
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    // Tantivy logs every segment save at INFO, which would drown the journal
    // during a backfill; its own WARN+ is what an operator needs from it.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tantivy=warn"));
    // Logs go to stderr, which is the journal under systemd.
    let _ = fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}

fn main() {
    init_tracing();

    // Real buckets, not per-process summaries: the dashboard needs
    // `histogram_quantile(rate(...))` over the scrape window, which summaries
    // cannot serve (their quantiles are cumulative since start and do not
    // aggregate).
    use metrics_exporter_prometheus::{Matcher, PrometheusBuilder};
    let latency = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];
    let commits = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];
    let results = [0.0, 1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0];
    let builder = PrometheusBuilder::new()
        .set_buckets_for_metric(Matcher::Full("search_query_duration_seconds".into()), &latency)
        .and_then(|b| b.set_buckets_for_metric(Matcher::Full("search_http_request_duration_seconds".into()), &latency))
        .and_then(|b| b.set_buckets_for_metric(Matcher::Full("search_commit_duration_seconds".into()), &commits))
        .and_then(|b| b.set_buckets_for_metric(Matcher::Full("search_results_total".into()), &results));
    let metrics = match builder.and_then(|b| b.install_recorder()) {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!(%error, "cannot install the Prometheus recorder");
            std::process::exit(1)
        }
    };

    let mut index_dir = std::env::var("SEARCH_INDEX_DIR").unwrap_or_else(|_| DEFAULT_INDEX_DIR.into());
    let mut bind = std::env::var("SEARCH_BIND").unwrap_or_else(|_| DEFAULT_BIND.into());

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--index-dir" => index_dir = args.next().unwrap_or_else(|| usage()),
            "--bind" => bind = args.next().unwrap_or_else(|| usage()),
            "-h" | "--help" => usage(),
            other => {
                tracing::error!(%other, "unknown argument");
                usage()
            }
        }
    }

    let dir = PathBuf::from(&index_dir);
    let engine = Arc::new(match Engine::open(&dir) {
        Ok(engine) => engine,
        Err(error) => {
            tracing::error!(%error, "cannot open the index");
            std::process::exit(1)
        }
    });
    let health = engine.health();
    metrics::gauge!("search_index_docs").set(health.docs as f64);
    metrics::gauge!("search_index_segments").set(health.segments as f64);
    tracing::info!(index = %dir.display(), docs = health.docs, segments = health.segments, %bind, "started");

    if let Err(error) = http::serve(engine, &bind, metrics) {
        tracing::error!(%error, "serve failed");
        std::process::exit(1)
    }
}
