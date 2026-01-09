//! Package manager detection and installation
//!
//! Supports: bun, pnpm, npm, cargo

use anyhow::Result;
use std::path::Path;
use std::process::{Command, Stdio};

/// Detected package manager
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Bun,
    Pnpm,
    Npm,
    Cargo,
}

impl PackageManager {
    /// Get the command name
    pub fn command(&self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Pnpm => "pnpm",
            Self::Npm => "npm",
            Self::Cargo => "cargo",
        }
    }

    /// Get install arguments
    pub fn install_args(&self) -> &'static [&'static str] {
        match self {
            Self::Bun => &["install"],
            Self::Pnpm => &["install"],
            Self::Npm => &["install"],
            Self::Cargo => &["build"],
        }
    }
}

/// Detect package manager(s) for a directory
/// Returns all detected package managers (a project can have both package.json and Cargo.toml)
pub fn detect_package_managers(path: &Path) -> Vec<PackageManager> {
    let mut managers = Vec::new();

    // JavaScript package managers (mutually exclusive - pick one)
    if path.join("bun.lock").exists() || path.join("bun.lockb").exists() {
        managers.push(PackageManager::Bun);
    } else if path.join("pnpm-lock.yaml").exists() {
        managers.push(PackageManager::Pnpm);
    } else if path.join("package-lock.json").exists() {
        managers.push(PackageManager::Npm);
    } else if path.join("package.json").exists() {
        // Default to npm if package.json exists but no lockfile
        managers.push(PackageManager::Npm);
    }

    // Rust (can coexist with JS)
    if path.join("Cargo.toml").exists() {
        managers.push(PackageManager::Cargo);
    }

    managers
}

/// Run install for a package manager
/// Returns Ok(()) on success, Err on failure
pub fn run_install(path: &Path, pm: PackageManager) -> Result<()> {
    let output = Command::new(pm.command())
        .args(pm.install_args())
        .current_dir(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;

    if !output.status.success() {
        anyhow::bail!(
            "{} {} failed: {}",
            pm.command(),
            pm.install_args().join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

/// Run install for all detected package managers
/// Continues even if one fails, returns all errors
pub fn run_all_installs(path: &Path) -> Vec<(PackageManager, Result<()>)> {
    let managers = detect_package_managers(path);
    managers
        .into_iter()
        .map(|pm| (pm, run_install(path, pm)))
        .collect()
}

/// Run install with progress callback
/// Callback receives stderr/stdout lines as they come
pub fn run_install_with_progress<F>(path: &Path, pm: PackageManager, mut on_progress: F) -> Result<()>
where
    F: FnMut(&str),
{
    use std::io::{BufRead, BufReader};

    let mut child = Command::new(pm.command())
        .args(pm.install_args())
        .current_dir(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Read stderr for progress (most package managers output progress there)
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.is_empty() {
                on_progress(&line);
            }
        }
    }

    let status = child.wait()?;
    if !status.success() {
        anyhow::bail!("{} {} failed", pm.command(), pm.install_args().join(" "));
    }

    Ok(())
}
