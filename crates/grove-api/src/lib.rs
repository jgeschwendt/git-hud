//! grove-api: HTTP/SSE API server for grove
//!
//! Serves the web dashboard and API endpoints.
//! See README.md for endpoint documentation and diagrams.

pub mod mcp;
pub mod routes;
mod static_files;

use anyhow::Result;
use axum::Router;
use grove_core::{Config, Database, GitOps, StateManager};
use std::sync::Arc;
use tokio::net::TcpListener;

/// Shared application state
pub struct AppState {
    pub config: Config,
    pub state: Arc<StateManager>,
    pub git: Arc<GitOps>,
    pub db: Arc<Database>,
}

/// HTTP server wrapper
pub struct Server {
    config: Config,
    db: Arc<Database>,
}

impl Server {
    /// Create new server
    pub fn new(config: Config, db: Database) -> Self {
        Self {
            config,
            db: Arc::new(db),
        }
    }

    /// Run the server on given port
    pub async fn run(self, port: u16) -> Result<()> {
        let state_manager = StateManager::new(Arc::clone(&self.db));
        let git = Arc::new(GitOps::new());

        let app_state = AppState {
            config: self.config,
            state: state_manager,
            git,
            db: self.db,
        };

        let router = router(app_state);
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;

        tracing::info!("Server listening on http://localhost:{}", port);
        axum::serve(listener, router).await?;

        Ok(())
    }
}

/// Build the API router
pub fn router(state: AppState) -> Router {
    let state = Arc::new(state);

    Router::new()
        // API routes
        .merge(routes::api_routes())
        // Static files (fallback)
        .fallback(static_files::static_handler)
        .with_state(state)
}
