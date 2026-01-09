//! Static file serving
//!
//! Embeds Next.js static export at compile time.

use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

/// Embedded static files from Next.js export
#[derive(RustEmbed)]
#[folder = "../../out"]
struct StaticAssets;

/// Serve static files with SPA fallback
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Try exact path
    if let Some(content) = StaticAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime.as_ref())],
            content.data.to_vec(),
        )
            .into_response();
    }

    // Try with .html extension (clean URLs)
    let html_path = if path.is_empty() {
        "index.html".to_string()
    } else if !path.ends_with(".html") {
        format!("{}.html", path.trim_end_matches('/'))
    } else {
        path.to_string()
    };

    if let Some(content) = StaticAssets::get(&html_path) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            content.data.to_vec(),
        )
            .into_response();
    }

    // Try index.html in directory
    let index_path = format!("{}/index.html", path.trim_end_matches('/'));
    if let Some(content) = StaticAssets::get(&index_path) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            content.data.to_vec(),
        )
            .into_response();
    }

    // Fallback to /home/index.html (Next.js static export structure)
    if let Some(content) = StaticAssets::get("home/index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            content.data.to_vec(),
        )
            .into_response();
    }

    // Last resort: root index.html
    if let Some(content) = StaticAssets::get("index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            content.data.to_vec(),
        )
            .into_response();
    }

    (StatusCode::NOT_FOUND, "Not found").into_response()
}
