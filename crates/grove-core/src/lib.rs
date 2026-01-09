//! grove-core: Domain logic for grove
//!
//! This crate contains the core business logic with no HTTP or UI dependencies.
//! See README.md for pseudocode and diagrams.

pub mod config;
pub mod db;
pub mod git;
pub mod install;
pub mod state;
pub mod types;

pub use config::Config;
pub use db::Database;
pub use git::{share_files, GitOps};
pub use install::{detect_package_managers, run_install, PackageManager};
pub use state::{FullState, StateManager};
pub use types::*;
