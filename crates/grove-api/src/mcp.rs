//! MCP (Model Context Protocol) server implementation
//!
//! Exposes grove operations as MCP tools for AI assistants.

use crate::AppState;
use rmcp::{
    handler::server::ServerHandler,
    model::*,
    service::RequestContext,
    ErrorData as McpError,
};
use std::sync::Arc;

/// Grove MCP server handler
#[derive(Clone)]
pub struct GroveMcp {
    state: Arc<AppState>,
}

/// Helper to build input schema from JSON
fn schema(json: serde_json::Value) -> Arc<serde_json::Map<String, serde_json::Value>> {
    match json {
        serde_json::Value::Object(map) => Arc::new(map),
        _ => Arc::new(serde_json::Map::new()),
    }
}

impl GroveMcp {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn make_tools() -> Vec<Tool> {
        vec![
            Tool {
                name: "list_repositories".into(),
                description: Some("List all tracked git repositories in grove".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {},
                    "required": []
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "clone_repository".into(),
                description: Some("Clone a git repository into grove".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Git clone URL (SSH or HTTPS)"
                        }
                    },
                    "required": ["url"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "delete_repository".into(),
                description: Some("Delete a repository and all its worktrees from grove".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The repository ID to delete"
                        }
                    },
                    "required": ["id"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "list_worktrees".into(),
                description: Some("List all worktrees for a repository".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "repo_id": {
                            "type": "string",
                            "description": "The repository ID"
                        }
                    },
                    "required": ["repo_id"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "create_worktree".into(),
                description: Some("Create a new worktree for a repository".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "repo_id": {
                            "type": "string",
                            "description": "The repository ID"
                        },
                        "branch": {
                            "type": "string",
                            "description": "Branch name to checkout or create"
                        }
                    },
                    "required": ["repo_id", "branch"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "delete_worktree".into(),
                description: Some("Delete a worktree from a repository".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "repo_id": {
                            "type": "string",
                            "description": "The repository ID"
                        },
                        "path": {
                            "type": "string",
                            "description": "The worktree path to delete"
                        }
                    },
                    "required": ["repo_id", "path"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
            Tool {
                name: "refresh_worktrees".into(),
                description: Some("Refresh git status for all worktrees in a repository".into()),
                input_schema: schema(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "repo_id": {
                            "type": "string",
                            "description": "The repository ID"
                        }
                    },
                    "required": ["repo_id"]
                })),
                annotations: None,
                icons: None,
                meta: None,
                output_schema: None,
                title: None,
            },
        ]
    }

    fn text_result(text: impl Into<String>, is_error: bool) -> CallToolResult {
        CallToolResult {
            content: vec![Content::text(text)],
            is_error: if is_error { Some(true) } else { None },
            meta: None,
            structured_content: None,
        }
    }

    async fn handle_tool(&self, name: &str, args: serde_json::Value) -> CallToolResult {
        match name {
            "list_repositories" => self.list_repositories().await,
            "clone_repository" => {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                self.clone_repository(url).await
            }
            "delete_repository" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                self.delete_repository(id).await
            }
            "list_worktrees" => {
                let repo_id = args.get("repo_id").and_then(|v| v.as_str()).unwrap_or("");
                self.list_worktrees(repo_id).await
            }
            "create_worktree" => {
                let repo_id = args.get("repo_id").and_then(|v| v.as_str()).unwrap_or("");
                let branch = args.get("branch").and_then(|v| v.as_str()).unwrap_or("");
                self.create_worktree(repo_id, branch).await
            }
            "delete_worktree" => {
                let repo_id = args.get("repo_id").and_then(|v| v.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
                self.delete_worktree(repo_id, path).await
            }
            "refresh_worktrees" => {
                let repo_id = args.get("repo_id").and_then(|v| v.as_str()).unwrap_or("");
                self.refresh_worktrees(repo_id).await
            }
            _ => Self::text_result(format!("Unknown tool: {}", name), true),
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Tool Implementations
    // ─────────────────────────────────────────────────────────────

    async fn list_repositories(&self) -> CallToolResult {
        match self.state.db.list_repositories() {
            Ok(repos) => {
                let text = serde_json::to_string_pretty(&repos).unwrap_or_else(|_| "[]".to_string());
                Self::text_result(text, false)
            }
            Err(e) => Self::text_result(format!("Failed to list repositories: {}", e), true),
        }
    }

    async fn clone_repository(&self, url: &str) -> CallToolResult {
        // Validate URL
        let parsed = match self.state.git.parse_url(url) {
            Some(p) => p,
            None => return Self::text_result("Invalid Git URL", true),
        };

        // Check if already exists
        if let Ok(Some(existing)) = self.state.db.get_repository_by_name(
            &parsed.provider,
            &parsed.username,
            &parsed.name,
        ) {
            return Self::text_result(
                format!(
                    "Repository {}/{} already exists at {}",
                    parsed.username, parsed.name, existing.local_path
                ),
                true,
            );
        }

        // Build paths
        let local_path = self
            .state
            .config
            .code_dir
            .join(&parsed.username)
            .join(&parsed.name);

        // Insert immediately
        let repo_id = match self.state.db.insert_repository(&grove_core::NewRepository {
            provider: parsed.provider.clone(),
            username: parsed.username.clone(),
            name: parsed.name.clone(),
            clone_url: url.to_string(),
            local_path: local_path.to_string_lossy().to_string(),
            repo_type: "bare".to_string(),
            default_branch: "main".to_string(),
            last_synced: 0,
        }) {
            Ok(id) => id,
            Err(e) => return Self::text_result(format!("Failed to create repository record: {}", e), true),
        };

        self.state.state.set_progress(&repo_id, Some("Cloning repository..."));
        self.state.state.on_db_change();

        // Spawn clone task
        let state = Arc::clone(&self.state);
        let url = url.to_string();
        let repo_id_clone = repo_id.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::routes::do_clone(state.clone(), &url, &repo_id_clone, false).await {
                tracing::error!("MCP clone failed: {}", e);
            }
        });

        Self::text_result(format!("Clone started. Repository ID: {}", repo_id), false)
    }

    async fn delete_repository(&self, id: &str) -> CallToolResult {
        match self.state.db.delete_repository(id) {
            Ok(_) => {
                self.state.state.on_db_change();
                Self::text_result(format!("Repository {} deleted", id), false)
            }
            Err(e) => Self::text_result(format!("Failed to delete repository: {}", e), true),
        }
    }

    async fn list_worktrees(&self, repo_id: &str) -> CallToolResult {
        match self.state.db.list_worktrees(repo_id) {
            Ok(worktrees) => {
                let text = serde_json::to_string_pretty(&worktrees).unwrap_or_else(|_| "[]".to_string());
                Self::text_result(text, false)
            }
            Err(e) => Self::text_result(format!("Failed to list worktrees: {}", e), true),
        }
    }

    async fn create_worktree(&self, repo_id: &str, branch: &str) -> CallToolResult {
        // Get repository
        let repo = match self.state.db.get_repository(repo_id) {
            Ok(Some(r)) => r,
            Ok(None) => return Self::text_result("Repository not found", true),
            Err(e) => return Self::text_result(format!("Failed to get repository: {}", e), true),
        };

        let local_path = std::path::PathBuf::from(&repo.local_path);
        let worktree_name = crate::routes::sanitize_branch_name(branch, &repo.default_branch);
        let worktree_path = local_path.join(&worktree_name);
        let worktree_display = worktree_path.display().to_string();

        // Insert worktree record
        if let Err(e) = self.state.db.insert_worktree(&grove_core::NewWorktree {
            path: worktree_path.to_string_lossy().to_string(),
            repo_id: repo_id.to_string(),
            branch: branch.to_string(),
            status: grove_core::WorktreeStatus::Creating,
        }) {
            return Self::text_result(format!("Failed to create worktree record: {}", e), true);
        }
        self.state.state.on_db_change();

        // Spawn create task
        let state = Arc::clone(&self.state);
        let branch = branch.to_string();
        let repo_id = repo_id.to_string();
        let main_path = local_path.join(".main");
        let worktree_path_str = worktree_path.to_string_lossy().to_string();

        tokio::spawn(async move {
            let result = crate::routes::do_create_worktree(
                state.clone(),
                &local_path,
                &main_path,
                &worktree_path,
                &branch,
                &repo_id,
                false,
            )
            .await;

            if let Err(e) = result {
                tracing::error!("MCP create worktree failed: {}", e);
                let _ = state.db.update_worktree_status(
                    &worktree_path_str,
                    grove_core::WorktreeStatus::Error,
                    None,
                    None,
                );
                state.state.on_db_change();
            }
        });

        Self::text_result(format!("Creating worktree at {}", worktree_display), false)
    }

    async fn delete_worktree(&self, _repo_id: &str, path: &str) -> CallToolResult {
        // Get worktree
        let worktree = match self.state.db.get_worktree(path) {
            Ok(Some(w)) => w,
            Ok(None) => return Self::text_result("Worktree not found", true),
            Err(e) => return Self::text_result(format!("Failed to get worktree: {}", e), true),
        };

        // Get repository
        let repo = match self.state.db.get_repository(&worktree.repo_id) {
            Ok(Some(r)) => r,
            Ok(None) => return Self::text_result("Repository not found", true),
            Err(e) => return Self::text_result(format!("Failed to get repository: {}", e), true),
        };

        // Update status
        let _ = self.state.db.update_worktree_status(
            path,
            grove_core::WorktreeStatus::Deleting,
            worktree.head.as_deref(),
            worktree.commit_message.as_deref(),
        );
        self.state.state.on_db_change();

        // Spawn delete task
        let state = Arc::clone(&self.state);
        let path_owned = path.to_string();
        let local_path = std::path::PathBuf::from(&repo.local_path);
        let worktree_path = std::path::PathBuf::from(path);

        tokio::spawn(async move {
            let _ = state.git.remove_worktree(&local_path, &worktree_path).await;
            if worktree_path.exists() {
                let _ = tokio::fs::remove_dir_all(&worktree_path).await;
            }
            let _ = state.db.delete_worktree(&path_owned);
            state.state.on_db_change();
        });

        Self::text_result(format!("Deleting worktree: {}", path), false)
    }

    async fn refresh_worktrees(&self, repo_id: &str) -> CallToolResult {
        let repo = match self.state.db.get_repository(repo_id) {
            Ok(Some(r)) => r,
            Ok(None) => return Self::text_result("Repository not found", true),
            Err(e) => return Self::text_result(format!("Failed to get repository: {}", e), true),
        };

        let state = Arc::clone(&self.state);
        let repo_id = repo_id.to_string();
        let local_path = std::path::PathBuf::from(&repo.local_path);

        tokio::spawn(async move {
            state.state.set_progress(&repo_id, Some("Fetching..."));

            if let Err(e) = state.git.fetch(&local_path, "origin").await {
                tracing::error!("Fetch failed: {}", e);
            }

            if let Ok(worktrees) = state.db.list_worktrees(&repo_id) {
                for wt in worktrees {
                    let wt_path = std::path::PathBuf::from(&wt.path);
                    if let Ok(status) = state.git.get_status(&wt_path) {
                        let _ = state.db.update_worktree_status(
                            &wt.path,
                            grove_core::WorktreeStatus::Ready,
                            status.head.as_deref(),
                            status.commit_message.as_deref(),
                        );
                        let _ = state.db.update_worktree_git_status(
                            &wt.path,
                            status.dirty,
                            status.ahead,
                            status.behind,
                        );
                    }
                }
            }

            let _ = state.db.update_repository_synced(&repo_id);
            state.state.set_progress(&repo_id, None);
            state.state.on_db_change();
        });

        Self::text_result("Refresh started", false)
    }
}

// ─────────────────────────────────────────────────────────────
// ServerHandler Implementation
// ─────────────────────────────────────────────────────────────

impl ServerHandler for GroveMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::LATEST,
            capabilities: ServerCapabilities {
                tools: Some(ToolsCapability {
                    list_changed: None,
                }),
                ..Default::default()
            },
            server_info: Implementation {
                name: "grove".into(),
                version: "0.2.0".into(),
                title: None,
                icons: None,
                website_url: None,
            },
            instructions: Some("Grove is a git worktree dashboard. Use these tools to manage repositories and worktrees.".into()),
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: Self::make_tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        _context: RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = request
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::Value::Null);
        Ok(self.handle_tool(&request.name, args).await)
    }
}
