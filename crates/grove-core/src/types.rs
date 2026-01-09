//! Shared types for grove

use serde::{Deserialize, Serialize};

/// Repository record from database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repository {
    pub id: String,
    pub provider: String,
    pub username: String,
    pub name: String,
    pub clone_url: String,
    pub local_path: String,
    #[serde(rename = "type")]
    pub repo_type: Option<String>,
    pub default_branch: String,
    pub last_synced: i64,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

/// New repository for insertion
#[derive(Debug, Clone)]
pub struct NewRepository {
    pub provider: String,
    pub username: String,
    pub name: String,
    pub clone_url: String,
    pub local_path: String,
    pub repo_type: String,
    pub default_branch: String,
    pub last_synced: i64,
}

/// Worktree record from database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub repo_id: String,
    pub branch: String,
    pub head: Option<String>,
    pub status: WorktreeStatus,
    pub commit_message: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
    pub last_status_check: Option<i64>,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

/// New worktree for insertion
#[derive(Debug, Clone)]
pub struct NewWorktree {
    pub path: String,
    pub repo_id: String,
    pub branch: String,
    pub status: WorktreeStatus,
}

/// Worktree status enum
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeStatus {
    Creating,
    Ready,
    Error,
    Deleting,
}

impl WorktreeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Ready => "ready",
            Self::Error => "error",
            Self::Deleting => "deleting",
        }
    }
}

impl std::str::FromStr for WorktreeStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "creating" => Ok(Self::Creating),
            "ready" => Ok(Self::Ready),
            "error" => Ok(Self::Error),
            "deleting" => Ok(Self::Deleting),
            _ => anyhow::bail!("invalid worktree status: {}", s),
        }
    }
}

/// Worktree configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeConfig {
    pub repo_id: String,
    pub symlink_patterns: Option<String>,
    pub copy_patterns: Option<String>,
    pub upstream_remote: String,
}

/// Git status for a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub head: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
    pub commit_message: Option<String>,
}

/// Repository with its worktrees (for full state)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoWithWorktrees {
    #[serde(flatten)]
    pub repo: Repository,
    pub worktrees: Vec<Worktree>,
}

/// Parsed git URL components
#[derive(Debug, Clone)]
pub struct ParsedGitUrl {
    pub provider: String,
    pub username: String,
    pub name: String,
    pub url: String,
}
