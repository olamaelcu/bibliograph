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

fn init_tracing() -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    use tracing_subscriber::{fmt, EnvFilter};
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    // Tantivy logs every segment save at INFO, which would drown the journal
    // during a backfill; its own WARN+ is what an operator needs from it.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tantivy=warn"));
    // Logs go to stderr (the journal under systemd), and a span close line makes
    // every request visible there: without it a span with no events prints
    // nothing and the journal cannot answer "what did we serve".
    let fmt_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_span_events(fmt::format::FmtSpan::CLOSE);

    let provider = otlp_provider();
    let otel_layer = provider.as_ref().map(|provider| {
        // Explicit tracer, not the global one: the layer keeps whatever tracer
        // it is built with, and a global set after the layer would not be seen.
        use opentelemetry::trace::TracerProvider as _;
        tracing_opentelemetry::layer().with_tracer(provider.tracer("bibliograph-search"))
    });
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();
    provider
}

/// An OTLP exporter only when the environment names one; otherwise tracing is
/// fmt-only and the process carries no exporter thread.
fn otlp_provider() -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    if endpoint.trim().is_empty() {
        return None;
    }
    let exporter = match opentelemetry_otlp::SpanExporter::builder().with_http().build() {
        Ok(exporter) => exporter,
        Err(error) => {
            eprintln!("otel: cannot build the OTLP exporter: {error}");
            return None;
        }
    };
    let resource = opentelemetry_sdk::Resource::builder()
        .with_service_name("bibliograph-search")
        .build();
    Some(
        opentelemetry_sdk::trace::SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(resource)
            .build(),
    )
}

fn main() {
    let tracing_provider = init_tracing();

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
    if let Some(provider) = tracing_provider {
        let _ = provider.shutdown();
    }
}
