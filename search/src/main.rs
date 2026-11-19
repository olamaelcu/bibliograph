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

fn main() {
    let mut index_dir = std::env::var("SEARCH_INDEX_DIR").unwrap_or_else(|_| DEFAULT_INDEX_DIR.into());
    let mut bind = std::env::var("SEARCH_BIND").unwrap_or_else(|_| DEFAULT_BIND.into());

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--index-dir" => index_dir = args.next().unwrap_or_else(|| usage()),
            "--bind" => bind = args.next().unwrap_or_else(|| usage()),
            "-h" | "--help" => usage(),
            other => {
                eprintln!("unknown argument: {other}");
                usage()
            }
        }
    }

    let dir = PathBuf::from(&index_dir);
    let engine = Arc::new(match Engine::open(&dir) {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("cannot open index: {error}");
            std::process::exit(1)
        }
    });
    let health = engine.health();
    println!(
        "bibliograph-search: index {} docs={} segments={} bind={}",
        dir.display(),
        health.docs,
        health.segments,
        bind
    );
    if let Err(error) = http::serve(engine, &bind) {
        eprintln!("serve: {error}");
        std::process::exit(1)
    }
}
