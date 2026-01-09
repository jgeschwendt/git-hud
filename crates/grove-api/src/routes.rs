//! API route handlers
//!
//! See README.md for endpoint documentation.

use crate::mcp::GroveMcp;
use crate::AppState;
use axum::{
    body::Body,
    extract::State,
    response::{IntoResponse, sse::{Event, KeepAlive, Sse}},
    routing::{any, delete, get, post},
    Json, Router,
};
use futures::stream::Stream;
use grove_core::{
    detect_package_managers, run_install, share_files, NewRepository, NewWorktree, WorktreeConfig,
    WorktreeStatus,
};
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_service::Service;

/// Build API routes
pub fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        // SSE state stream
        .route("/api/state", get(sse_handler))
        // State snapshot (non-SSE)
        .route("/api/state/snapshot", get(state_snapshot))
        // Repositories
        .route("/api/repositories", get(list_repositories))
        .route("/api/clone", post(clone_repository))
        .route("/api/repositories/{id}", delete(delete_repository))
        // Worktrees
        .route("/api/worktree", post(create_worktree))
        .route("/api/worktree/{*path}", delete(delete_worktree))
        // Actions
        .route("/api/open", post(open_in_editor))
        .route("/api/refresh/{id}", post(refresh_repository))
        // MCP endpoint
        .route("/mcp", any(mcp_handler))
}

// ─────────────────────────────────────────────────────────────
// SSE State Stream
// ─────────────────────────────────────────────────────────────

async fn sse_handler(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.state.subscribe();

    // Send initial state first
    let initial = state.state.get_full_state();

    let stream = async_stream::stream! {
        // Initial state
        if let Ok(data) = serde_json::to_string(&initial) {
            yield Ok(Event::default().data(data));
        }

        // Subscribe to updates
        let mut stream = BroadcastStream::new(rx);
        while let Some(Ok(state)) = stream.next().await {
            if let Ok(data) = serde_json::to_string(&state) {
                yield Ok(Event::default().data(data));
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn state_snapshot(
    State(state): State<Arc<AppState>>,
) -> Json<grove_core::FullState> {
    Json(state.state.get_full_state())
}

// ─────────────────────────────────────────────────────────────
// MCP Handler
// ─────────────────────────────────────────────────────────────

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    request: axum::http::Request<Body>,
) -> axum::response::Response {
    // Create MCP service per request
    let mcp = GroveMcp::new(Arc::clone(&state));
    let session_manager = Arc::new(LocalSessionManager::default());
    let config = StreamableHttpServerConfig {
        stateful_mode: false, // Stateless mode for simplicity
        ..Default::default()
    };

    let mut service = StreamableHttpService::new(
        move || Ok(mcp.clone()),
        session_manager,
        config,
    );

    // Call the MCP service
    match service.call(request).await {
        Ok(response) => response.into_response(),
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// ─────────────────────────────────────────────────────────────
// Repository Endpoints
// ─────────────────────────────────────────────────────────────

async fn list_repositories(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<grove_core::Repository>>, ApiError> {
    let repos = state.db.list_repositories()?;
    Ok(Json(repos))
}

#[derive(Debug, Deserialize)]
struct CloneRequest {
    url: String,
    #[serde(default)]
    skip_install: bool,
}

#[derive(Debug, Serialize)]
struct CloneResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn clone_repository(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CloneRequest>,
) -> Result<Json<CloneResponse>, ApiError> {
    // Validate URL
    let parsed = match state.git.parse_url(&req.url) {
        Some(p) => p,
        None => {
            return Ok(Json(CloneResponse {
                ok: false,
                error: Some("Invalid Git URL".to_string()),
            }));
        }
    };

    // Check if repo already exists (by name)
    if let Ok(Some(existing)) =
        state
            .db
            .get_repository_by_name(&parsed.provider, &parsed.username, &parsed.name)
    {
        return Ok(Json(CloneResponse {
            ok: false,
            error: Some(format!(
                "Repository {}/{} already exists at {}. Delete it first.",
                parsed.username, parsed.name, existing.local_path
            )),
        }));
    }

    // Build paths
    let local_path = state
        .config
        .code_dir
        .join(&parsed.username)
        .join(&parsed.name);

    // Insert repository immediately so UI shows it
    let repo_id = state.db.insert_repository(&NewRepository {
        provider: parsed.provider.clone(),
        username: parsed.username.clone(),
        name: parsed.name.clone(),
        clone_url: req.url.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        repo_type: "bare".to_string(),
        default_branch: "main".to_string(), // placeholder, updated after clone
        last_synced: 0, // updated after clone
    })?;

    // Set progress and notify UI
    state.state.set_progress(&repo_id, Some("Cloning repository..."));
    state.state.on_db_change();

    // Fire and forget - spawn background clone task
    let state_clone = Arc::clone(&state);
    let url = req.url.clone();
    let skip_install = req.skip_install;
    tokio::spawn(async move {
        if let Err(e) = do_clone(state_clone, &url, &repo_id, skip_install).await {
            tracing::error!("Clone failed: {}", e);
        }
    });

    Ok(Json(CloneResponse {
        ok: true,
        error: None,
    }))
}

/// Perform the actual clone operation (runs in background)
pub async fn do_clone(state: Arc<AppState>, url: &str, repo_id: &str, skip_install: bool) -> anyhow::Result<()> {
    let parsed = state
        .git
        .parse_url(url)
        .ok_or_else(|| anyhow::anyhow!("Invalid URL"))?;

    let local_path = state
        .config
        .code_dir
        .join(&parsed.username)
        .join(&parsed.name);
    let bare_path = local_path.join(".bare");
    let main_path = local_path.join(".main");

    let repo_id = repo_id.to_string();

    // Wrap in closure to handle cleanup on error
    let result: anyhow::Result<()> = async {
        // Check if directory exists and remove it
        if local_path.exists() {
            state
                .state
                .set_progress(&repo_id, Some("Cleaning up existing directory..."));
            tokio::fs::remove_dir_all(&local_path).await?;
        }

        // Create parent directory
        tokio::fs::create_dir_all(&local_path).await?;

        // 1. Clone as bare
        state
            .state
            .set_progress(&repo_id, Some("Cloning repository..."));
        state.git.clone_bare(url, &bare_path, |_msg| {}).await?;

        // 2. Create .git file pointing to bare repo
        state
            .state
            .set_progress(&repo_id, Some("Configuring repository..."));
        tokio::fs::write(local_path.join(".git"), "gitdir: ./.bare\n").await?;

        // 3. Configure remote fetch
        state.git.config(
            &local_path,
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        )?;

        // 4. Fetch all branches
        state
            .state
            .set_progress(&repo_id, Some("Fetching branches..."));
        state.git.fetch(&local_path, "origin").await?;

        // 5. Detect default branch and update repo
        state
            .state
            .set_progress(&repo_id, Some("Detecting default branch..."));
        let default_branch = state
            .git
            .detect_default_branch(&local_path)
            .unwrap_or_else(|_| "main".to_string());

        // Update repo with detected default branch
        state.db.update_repository_default_branch(&repo_id, &default_branch)?;
        state.db.update_repository_synced(&repo_id)?;
        state.state.on_db_change();

        // 6. Insert worktree in DB (status=creating)
        state
            .state
            .set_progress(&repo_id, Some("Creating main worktree..."));
        state.db.insert_worktree(&NewWorktree {
            path: main_path.to_string_lossy().to_string(),
            repo_id: repo_id.clone(),
            branch: default_branch.clone(),
            status: WorktreeStatus::Creating,
        })?;
        state.state.on_db_change();

        // 7. Delete local branch (bare clone creates it) and create worktree with tracking
        let _ = std::process::Command::new("git")
            .args(["branch", "-D", &default_branch])
            .current_dir(&local_path)
            .output();

        state
            .git
            .create_worktree(&local_path, &main_path, &default_branch, "origin")
            .await?;

        // 8. Install dependencies (unless skip_install)
        if !skip_install {
            let managers = detect_package_managers(&main_path);
            for pm in managers {
                state.state.set_progress(
                    &repo_id,
                    Some(&format!("Installing ({})...", pm.command())),
                );
                if let Err(e) = run_install(&main_path, pm) {
                    tracing::warn!("Install {} failed: {}", pm.command(), e);
                    state
                        .state
                        .set_progress(&repo_id, Some(&format!("Warning: {} install failed", pm.command())));
                }
            }
        }

        // 9. Get git status and update worktree to ready
        state.state.set_progress(&repo_id, Some("Getting status..."));
        let git_status = state.git.get_status(&main_path)?;

        state.db.update_worktree_status(
            &main_path.to_string_lossy(),
            WorktreeStatus::Ready,
            git_status.head.as_deref(),
            git_status.commit_message.as_deref(),
        )?;

        state.db.update_worktree_git_status(
            &main_path.to_string_lossy(),
            git_status.dirty,
            git_status.ahead,
            git_status.behind,
        )?;

        // 10. Save worktree config
        state.db.upsert_worktree_config(&WorktreeConfig {
            repo_id: repo_id.clone(),
            symlink_patterns: Some(".env,.env.*,.claude/**".to_string()),
            copy_patterns: Some(String::new()),
            upstream_remote: "origin".to_string(),
        })?;

        // Clear progress and push final state
        state.state.set_progress(&repo_id, None);
        state.state.on_db_change();

        tracing::info!("Clone complete: {} -> {}", url, local_path.display());
        Ok(())
    }
    .await;

    // Handle cleanup on error
    if let Err(e) = result {
        // Clear progress
        state.state.set_progress(&repo_id, None);
        // Delete repo from DB
        let _ = state.db.delete_repository(&repo_id);

        // Remove directory
        if local_path.exists() {
            let _ = tokio::fs::remove_dir_all(&local_path).await;
        }

        state.state.on_db_change();
        return Err(e);
    }

    Ok(())
}

async fn delete_repository(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Get repository to find local path
    let repo = state
        .db
        .get_repository(&id)?
        .ok_or_else(|| ApiError::NotFound("Repository not found".to_string()))?;

    let local_path = PathBuf::from(&repo.local_path);

    // Show deleting state
    state.state.set_progress(&id, Some("Deleting..."));
    state.state.on_db_change();

    // Delete directory from disk
    if local_path.exists() {
        tokio::fs::remove_dir_all(&local_path)
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to delete directory: {}", e)))?;
    }

    // Delete from database (cascades to worktrees)
    state.db.delete_repository(&id)?;

    // Clear progress
    state.state.set_progress(&id, None);
    state.state.on_db_change();

    Ok(Json(serde_json::json!({ "success": true })))
}

// ─────────────────────────────────────────────────────────────
// Worktree Endpoints
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CreateWorktreeRequest {
    repo_id: String,
    branch: String,
    #[serde(default)]
    skip_install: bool,
}

/// Sanitize branch name for directory name
/// - Preserve dots (v1.0.0), underscores (feature_foo)
/// - Use -- for path separators (feature/foo → feature--foo)
/// - Replace .. with __ to prevent traversal
pub fn sanitize_branch_name(branch: &str, default_branch: &str) -> String {
    if branch == default_branch {
        ".main".to_string()
    } else {
        branch
            .replace("..", "__")
            .replace('/', "--")
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
            .collect()
    }
}

async fn create_worktree(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateWorktreeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Get repository
    let repo = state
        .db
        .get_repository(&req.repo_id)?
        .ok_or_else(|| ApiError::NotFound("Repository not found".to_string()))?;

    // Validate branch name
    let branch = req.branch.trim();
    if branch.is_empty() || branch.chars().all(|c| c == '.') {
        return Err(ApiError::BadRequest("Invalid branch name".to_string()));
    }

    // Build worktree path with sanitized name
    let local_path = PathBuf::from(&repo.local_path);
    let worktree_name = sanitize_branch_name(branch, &repo.default_branch);
    let worktree_path = local_path.join(&worktree_name);
    let main_path = local_path.join(".main");

    // Ensure worktree path is within repo path (defense in depth)
    if !worktree_path.starts_with(&local_path) {
        return Err(ApiError::BadRequest("Invalid worktree path".to_string()));
    }

    // Check if worktree already exists
    if let Ok(Some(_)) = state.db.get_worktree(&worktree_path.to_string_lossy()) {
        return Err(ApiError::BadRequest("Worktree already exists".to_string()));
    }

    // Insert worktree in DB (status=creating)
    state.db.insert_worktree(&NewWorktree {
        path: worktree_path.to_string_lossy().to_string(),
        repo_id: req.repo_id.clone(),
        branch: branch.to_string(),
        status: WorktreeStatus::Creating,
    })?;
    state.state.on_db_change();

    // Spawn background task to create worktree
    let state_clone = Arc::clone(&state);
    let branch_owned = branch.to_string();
    let repo_id = req.repo_id.clone();
    let skip_install = req.skip_install;
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    tokio::spawn(async move {
        let result = do_create_worktree(
            state_clone.clone(),
            &local_path,
            &main_path,
            &worktree_path,
            &branch_owned,
            &repo_id,
            skip_install,
        )
        .await;

        if let Err(e) = result {
            tracing::error!("Failed to create worktree: {}", e);
            // Update status to error
            let _ = state_clone.db.update_worktree_status(
                &worktree_path_str,
                WorktreeStatus::Error,
                None,
                None,
            );
            state_clone.state.on_db_change();
        }
    });

    Ok(Json(serde_json::json!({
        "ok": true,
        "message": format!("Creating worktree {}", req.branch)
    })))
}

/// Sync main worktree before creating new worktrees
/// - Fetches from remote to get latest refs
/// - Pulls main to update it
/// - Installs dependencies to warm package cache
async fn sync_main_worktree(
    state: Arc<AppState>,
    repo_id: &str,
    local_path: &PathBuf,
    main_path: &PathBuf,
) {
    // Fetch from remote
    state.state.set_progress(repo_id, Some("Fetching..."));
    if let Err(e) = state.git.fetch(local_path, "origin").await {
        tracing::warn!("Fetch failed during main sync: {}", e);
    }

    // Pull main worktree
    state.state.set_progress(repo_id, Some("Pulling main..."));
    if let Err(e) = state.git.pull(main_path).await {
        tracing::warn!("Pull main failed: {}", e);
    }

    // Install dependencies to warm cache
    let managers = detect_package_managers(main_path);
    for pm in managers {
        state
            .state
            .set_progress(repo_id, Some(&format!("Installing main ({})...", pm.command())));
        if let Err(e) = run_install(main_path, pm) {
            tracing::warn!("Install main {} failed: {}", pm.command(), e);
        }
    }

    state.state.set_progress(repo_id, None);
}

pub async fn do_create_worktree(
    state: Arc<AppState>,
    local_path: &PathBuf,
    main_path: &PathBuf,
    worktree_path: &PathBuf,
    branch: &str,
    repo_id: &str,
    skip_install: bool,
) -> anyhow::Result<()> {
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    // 1. Sync main worktree first (fetch, pull, install to warm cache)
    sync_main_worktree(state.clone(), repo_id, local_path, main_path).await;

    // 2. Create git worktree
    state
        .state
        .set_progress(&worktree_path_str, Some("Creating worktree..."));
    state
        .git
        .create_worktree(local_path, worktree_path, branch, "origin")
        .await?;

    // 3. Share files from .main
    state
        .state
        .set_progress(&worktree_path_str, Some("Sharing files..."));
    if let Ok(Some(config)) = state.db.get_worktree_config(repo_id) {
        let symlink_patterns: Vec<&str> = config
            .symlink_patterns
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        let copy_patterns: Vec<&str> = config
            .copy_patterns
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        if !symlink_patterns.is_empty() || !copy_patterns.is_empty() {
            if let Err(e) = share_files(main_path, worktree_path, &symlink_patterns, &copy_patterns)
            {
                tracing::warn!("Failed to share files: {}", e);
            }
        }
    }

    // 4. Install dependencies (unless skip_install)
    if !skip_install {
        let managers = detect_package_managers(worktree_path);
        for pm in managers {
            state.state.set_progress(
                &worktree_path_str,
                Some(&format!("Installing ({})...", pm.command())),
            );
            if let Err(e) = run_install(worktree_path, pm) {
                tracing::warn!("Install {} failed: {}", pm.command(), e);
            }
        }
    }

    // 5. Get git status and update to ready
    state
        .state
        .set_progress(&worktree_path_str, Some("Getting status..."));
    let git_status = state.git.get_status(worktree_path)?;

    state.db.update_worktree_status(
        &worktree_path_str,
        WorktreeStatus::Ready,
        git_status.head.as_deref(),
        git_status.commit_message.as_deref(),
    )?;

    state.db.update_worktree_git_status(
        &worktree_path_str,
        git_status.dirty,
        git_status.ahead,
        git_status.behind,
    )?;

    // Clear progress
    state.state.set_progress(&worktree_path_str, None);
    state.state.set_progress(repo_id, None);
    state.state.on_db_change();

    Ok(())
}

async fn delete_worktree(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Get worktree to find repo
    let worktree = state
        .db
        .get_worktree(&path)?
        .ok_or_else(|| ApiError::NotFound("Worktree not found".to_string()))?;

    // Get repository for bare path
    let repo = state
        .db
        .get_repository(&worktree.repo_id)?
        .ok_or_else(|| ApiError::NotFound("Repository not found".to_string()))?;

    // Update status to deleting
    state.db.update_worktree_status(
        &path,
        WorktreeStatus::Deleting,
        worktree.head.as_deref(),
        worktree.commit_message.as_deref(),
    )?;
    state.state.on_db_change();

    // Spawn background task
    let state_clone = Arc::clone(&state);
    let path_clone = path.clone();
    tokio::spawn(async move {
        let local_path = PathBuf::from(&repo.local_path);
        let worktree_path = PathBuf::from(&path_clone);

        // Try to remove git worktree
        let result = state_clone
            .git
            .remove_worktree(&local_path, &worktree_path)
            .await;

        if let Err(e) = &result {
            // Log but continue - worktree might not exist in git
            tracing::warn!("git worktree remove failed (may be orphaned): {}", e);
        }

        // Clean up directory if it exists
        if worktree_path.exists() {
            if let Err(e) = tokio::fs::remove_dir_all(&worktree_path).await {
                tracing::warn!("Failed to remove worktree directory: {}", e);
            }
        }

        // Always delete from DB (cleanup orphaned records)
        let _ = state_clone.db.delete_worktree(&path_clone);
        state_clone.state.on_db_change();
    });

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenRequest {
    path: String,
}

async fn open_in_editor(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<OpenRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Open in VS Code
    std::process::Command::new("code")
        .arg(&req.path)
        .spawn()
        .map_err(|e| ApiError::Internal(format!("Failed to open editor: {}", e)))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn refresh_repository(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Get repository
    let repo = state
        .db
        .get_repository(&id)?
        .ok_or_else(|| ApiError::NotFound("Repository not found".to_string()))?;

    // Spawn background task to fetch and update status
    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        let local_path = PathBuf::from(&repo.local_path);

        // Fetch from remote
        state_clone
            .state
            .set_progress(&repo.id, Some("Fetching..."));
        if let Err(e) = state_clone.git.fetch(&local_path, "origin").await {
            tracing::error!("Fetch failed: {}", e);
        }

        // Update worktree statuses
        if let Ok(worktrees) = state_clone.db.list_worktrees(&repo.id) {
            for wt in worktrees {
                let wt_path = PathBuf::from(&wt.path);
                if let Ok(status) = state_clone.git.get_status(&wt_path) {
                    let _ = state_clone.db.update_worktree_status(
                        &wt.path,
                        WorktreeStatus::Ready,
                        status.head.as_deref(),
                        status.commit_message.as_deref(),
                    );
                    let _ = state_clone.db.update_worktree_git_status(
                        &wt.path,
                        status.dirty,
                        status.ahead,
                        status.behind,
                    );
                }
            }
        }

        // Update last_synced
        let _ = state_clone.db.update_repository_synced(&repo.id);

        state_clone.state.set_progress(&repo.id, None);
        state_clone.state.on_db_change();
    });

    Ok(Json(serde_json::json!({ "ok": true, "repo_id": id })))
}

// ─────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────

#[derive(Debug)]
enum ApiError {
    Internal(String),
    NotFound(String),
    BadRequest(String),
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            ApiError::Internal(msg) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, msg),
            ApiError::NotFound(msg) => (axum::http::StatusCode::NOT_FOUND, msg),
            ApiError::BadRequest(msg) => (axum::http::StatusCode::BAD_REQUEST, msg),
        };

        let body = serde_json::json!({ "error": message });
        (status, Json(body)).into_response()
    }
}
