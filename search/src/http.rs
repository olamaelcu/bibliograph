//! A minimal HTTP/1.1 server for the loopback interface.
//!
//! The service is reachable only from 127.0.0.1 on the catalog host; it speaks
//! three routes and no keep-alive, so a hand-rolled server with one thread per
//! connection is smaller and has fewer moving parts than an async runtime.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use crate::index::{DocsRequest, Engine};
use crate::query::SearchRequest;

const MAX_BODY: usize = 16 * 1024 * 1024;

pub fn serve(engine: Arc<Engine>, bind: &str) -> std::io::Result<()> {
    let listener = TcpListener::bind(bind)?;
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(_) => continue,
        };
        let engine = Arc::clone(&engine);
        std::thread::spawn(move || {
            if let Err(error) = handle(stream, &engine) {
                eprintln!("connection: {error}");
            }
        });
    }
    Ok(())
}

fn handle(mut stream: TcpStream, engine: &Engine) -> std::io::Result<()> {
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
        return respond(&mut stream, 413, r#"{"error":"request body too large"}"#);
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body)?;
    }

    let (status, payload) = route(engine, &method, &path, &body);
    respond(&mut stream, status, &payload)
}

fn route(engine: &Engine, method: &str, path: &str, body: &[u8]) -> (u16, String) {
    match (method, path) {
        ("GET", "/healthz") => (200, json(&engine.health())),
        ("POST", "/search") => match serde_json::from_slice::<SearchRequest>(body) {
            Ok(request) => match engine.search(&request) {
                Ok(response) => (200, json(&response)),
                Err(error) => (500, error_json(&error)),
            },
            Err(error) => (400, error_json(&format!("invalid search body: {error}"))),
        },
        ("POST", "/docs") => match serde_json::from_slice::<DocsRequest>(body) {
            Ok(request) => match engine.apply(request) {
                Ok(response) => (200, json(&response)),
                Err(error) => (500, error_json(&error)),
            },
            Err(error) => (400, error_json(&format!("invalid docs body: {error}"))),
        },
        _ => (404, error_json("not found")),
    }
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| error_json(&format!("encode: {error}")))
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn respond(stream: &mut TcpStream, status: u16, payload: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
        payload.len()
    )?;
    stream.flush()
}
