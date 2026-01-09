//! Server-side state manager
//!
//! Maintains in-memory progress tracking and pushes full state to clients via broadcast.
//! See README.md for pseudocode and diagrams.

use crate::types::RepoWithWorktrees;
use crate::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

/// Full state sent to clients
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullState {
    pub repositories: Vec<RepoWithWorktrees>,
    pub progress: HashMap<String, String>,
}

/// State manager with broadcast capability
pub struct StateManager {
    /// Broadcast sender for state updates
    tx: broadcast::Sender<FullState>,
    /// In-memory progress tracking: path -> message
    progress: RwLock<HashMap<String, String>>,
    /// Database reference
    db: Arc<Database>,
    /// Debounce state (pending push) - reserved for future use
    #[allow(dead_code)]
    pending_push: RwLock<bool>,
}

impl StateManager {
    /// Create new state manager
    pub fn new(db: Arc<Database>) -> Arc<Self> {
        let (tx, _) = broadcast::channel(16);
        Arc::new(Self {
            tx,
            progress: RwLock::new(HashMap::new()),
            db,
            pending_push: RwLock::new(false),
        })
    }

    /// Subscribe to state changes
    pub fn subscribe(&self) -> broadcast::Receiver<FullState> {
        self.tx.subscribe()
    }

    /// Set progress message for a path (repo.id or worktree.path)
    /// Pass None to clear progress
    pub fn set_progress(&self, path: &str, message: Option<&str>) {
        {
            let mut progress = self.progress.write().unwrap();
            match message {
                Some(msg) => {
                    progress.insert(path.to_string(), msg.to_string());
                }
                None => {
                    progress.remove(path);
                }
            }
        }
        self.schedule_push();
    }

    /// Schedule a debounced state push
    fn schedule_push(&self) {
        // For now, push immediately. Can add debouncing later with tokio::spawn
        self.push_state();
    }

    /// Push current state to all subscribers
    pub fn push_state(&self) {
        let state = self.get_full_state();
        // Ignore send errors (no receivers)
        let _ = self.tx.send(state);
    }

    /// Get current full state
    pub fn get_full_state(&self) -> FullState {
        let repositories = self.get_repos_with_worktrees();
        let progress = self.progress.read().unwrap().clone();

        FullState {
            repositories,
            progress,
        }
    }

    /// Get all repositories with their worktrees
    fn get_repos_with_worktrees(&self) -> Vec<RepoWithWorktrees> {
        let repos = match self.db.list_repositories() {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Failed to list repositories: {}", e);
                return vec![];
            }
        };

        repos
            .into_iter()
            .map(|repo| {
                let worktrees = self
                    .db
                    .list_worktrees(&repo.id)
                    .unwrap_or_else(|e| {
                        tracing::error!("Failed to list worktrees for {}: {}", repo.name, e);
                        vec![]
                    });

                RepoWithWorktrees { repo, worktrees }
            })
            .collect()
    }

    /// Notify that database changed (call after mutations)
    pub fn on_db_change(&self) {
        self.push_state();
    }
}
