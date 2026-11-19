//! A minimal HTTP/1.1 server for the loopback interface.
//!
//! The service is reachable only from 127.0.0.1 on the catalog host; it speaks
//! four routes and no keep-alive, so a hand-rolled server with one thread per
//! connection is smaller and has fewer moving parts than an async runtime.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Instant;

use metrics_exporter_prometheus::PrometheusHandle;
use tracing::info_span;

use crate::index::{DocsRequest, Engine};
use crate::query::SearchRequest;

const MAX_BODY: usize = 16 * 1024 * 1024;

pub fn serve(engine: Arc<Engine>, bind: &str, metrics: PrometheusHandle) -> std::io::Result<()> {
    let listener = TcpListener::bind(bind)?;
    tracing::info!(%bind, docs = engine.health().docs, "listening");
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(_) => continue,
        };
        let engine = Arc::clone(&engine);
        let metrics = metrics.clone();
        std::thread::spawn(move || {
            if let Err(error) = handle(stream, &engine, &metrics) {
                tracing::warn!(%error, "connection failed");
            }
        });
    }
    Ok(())
}

fn handle(mut stream: TcpStream, engine: &Engine, metrics: &PrometheusHandle) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    if length > MAX_BODY {
        return respond(&mut stream, 413, "application/json", r#"{"error":"request body too large"}"#);
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body)?;
    }

    let route = route_label(&method, &path);
    let span = info_span!("http", method = %method, route = %route);
    let started = Instant::now();
    let (status, content_type, payload) = span.in_scope(|| route_on(engine, metrics, &method, &path, &body));
    let elapsed = started.elapsed().as_secs_f64();
    metrics::counter!("search_http_requests_total", "route" => route.clone(), "status" => status.to_string()).increment(1);
    metrics::histogram!("search_http_request_duration_seconds", "route" => route).record(elapsed);
    respond(&mut stream, status, content_type, &payload)
}

fn route_label(method: &str, path: &str) -> &'static str {
    match (method, path) {
        ("GET", "/healthz") => "healthz",
        ("GET", "/metrics") => "metrics",
        ("POST", "/search") => "search",
        ("POST", "/docs") => "docs",
        _ => "other",
    }
}

fn route_on(
    engine: &Engine,
    metrics: &PrometheusHandle,
    method: &str,
    path: &str,
    body: &[u8],
) -> (u16, &'static str, String) {
    match (method, path) {
        ("GET", "/healthz") => {
            let health = engine.health();
            record_gauges(&health);
            (200, "application/json", json(&health))
        }
        ("GET", "/metrics") => (200, "text/plain; version=0.0.4", metrics.render()),
        ("POST", "/search") => match serde_json::from_slice::<SearchRequest>(body) {
            Ok(request) => {
                let sort = request.sort.clone().unwrap_or_else(|| "relevance".into());
                let started = Instant::now();
                match engine.search(&request) {
                    Ok(response) => {
                        metrics::counter!("search_requests_total", "outcome" => "ok", "sort" => sort.clone()).increment(1);
                        metrics::histogram!("search_query_duration_seconds", "sort" => sort.clone())
                            .record(started.elapsed().as_secs_f64());
                        metrics::histogram!("search_results_total", "sort" => sort)
                            .record(response.total as f64);
                        if response.uris.is_empty() {
                            metrics::counter!("search_empty_results_total").increment(1);
                        }
                        (200, "application/json", json(&response))
                    }
                    Err(error) => {
                        metrics::counter!("search_requests_total", "outcome" => "error", "sort" => sort)
                            .increment(1);
                        tracing::error!(%error, "search failed");
                        (500, "application/json", error_json(&error))
                    }
                }
            }
            Err(error) => {
                metrics::counter!("search_requests_total", "outcome" => "invalid").increment(1);
                (400, "application/json", error_json(&format!("invalid search body: {error}")))
            }
        },
        ("POST", "/docs") => match serde_json::from_slice::<DocsRequest>(body) {
            Ok(request) => {
                let upserts = request.upsert.len();
                let deletes = request.delete.len();
                match engine.apply(request) {
                    Ok(response) => {
                        metrics::counter!("search_docs_upserts_total").increment(upserts as u64);
                        metrics::counter!("search_docs_deletes_total").increment(deletes as u64);
                        metrics::gauge!("search_index_docs").set(response.docs as f64);
                        (200, "application/json", json(&response))
                    }
                    Err(error) => {
                        metrics::counter!("search_docs_batches_total", "outcome" => "error").increment(1);
                        tracing::error!(%error, "docs batch failed");
                        (500, "application/json", error_json(&error))
                    }
                }
            }
            Err(error) => {
                metrics::counter!("search_docs_batches_total", "outcome" => "invalid").increment(1);
                (400, "application/json", error_json(&format!("invalid docs body: {error}")))
            }
        },
        _ => (404, "application/json", error_json("not found")),
    }
}

fn record_gauges(health: &crate::schema::Health) {
    metrics::gauge!("search_index_docs").set(health.docs as f64);
    metrics::gauge!("search_index_segments").set(health.segments as f64);
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| error_json(&format!("encode: {error}")))
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, payload: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
        payload.len()
    )?;
    stream.flush()
}
