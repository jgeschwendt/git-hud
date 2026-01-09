//! Git operations
//!
//! Uses gix for clone/fetch/status, shells out to git CLI for worktree mutations.
//! See README.md for pseudocode and diagrams.

use crate::types::{GitStatus, ParsedGitUrl};
use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Command;

/// Git operations handler
pub struct GitOps;

impl GitOps {
    pub fn new() -> Self {
        Self
    }

    // ─────────────────────────────────────────────────────────────
    // URL Parsing
    // ─────────────────────────────────────────────────────────────

    /// Parse git URL into components
    pub fn parse_url(&self, url: &str) -> Option<ParsedGitUrl> {
        parse_git_url(url)
    }

    // ─────────────────────────────────────────────────────────────
    // Clone (using gix)
    // ─────────────────────────────────────────────────────────────

    /// Clone repository as bare using gix
    pub async fn clone_bare(
        &self,
        url: &str,
        bare_path: &Path,
        _progress: impl FnMut(&str),
    ) -> Result<()> {
        let url = url.to_string();
        let bare_path = bare_path.to_path_buf();

        // Run blocking gix operation in spawn_blocking
        tokio::task::spawn_blocking(move || {
            use gix::progress::Discard;

            // Prepare bare clone
            let mut prepare = gix::prepare_clone_bare(url, &bare_path)
                .context("failed to prepare clone")?;

            // Fetch - returns (Repository, Outcome)
            let (_repo, _outcome) = prepare
                .fetch_only(Discard, &gix::interrupt::IS_INTERRUPTED)
                .map_err(|e| anyhow::anyhow!("fetch failed: {:?}", e))?;

            // Repository is already persisted by fetch_only

            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("clone task panicked")??;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────

    /// Set git config value (still uses CLI - gix config is read-only)
    pub fn config(&self, repo_path: &Path, key: &str, value: &str) -> Result<()> {
        let output = Command::new("git")
            .args(["config", key, value])
            .current_dir(repo_path)
            .output()
            .context("failed to execute git config")?;

        if !output.status.success() {
            bail!(
                "git config failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Fetch (using gix)
    // ─────────────────────────────────────────────────────────────

    /// Fetch from remote using gix
    pub async fn fetch(&self, repo_path: &Path, remote: &str) -> Result<()> {
        let repo_path = repo_path.to_path_buf();
        let remote = remote.to_string();

        tokio::task::spawn_blocking(move || {
            use gix::bstr::BStr;
            use gix::progress::Discard;

            let repo = gix::open(&repo_path).context("failed to open repository")?;

            let remote = repo
                .find_remote(BStr::new(&remote))
                .context("failed to find remote")?;

            let connection = remote
                .connect(gix::remote::Direction::Fetch)
                .context("failed to connect to remote")?;

            let _outcome = connection
                .prepare_fetch(Discard, Default::default())
                .context("failed to prepare fetch")?
                .receive(Discard, &gix::interrupt::IS_INTERRUPTED)
                .context("failed to receive fetch")?;

            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("fetch task panicked")??;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Worktree Operations (git CLI - gix doesn't support mutations)
    // ─────────────────────────────────────────────────────────────

    /// Create worktree with smart branch detection
    pub async fn create_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
        remote: &str,
    ) -> Result<()> {
        let repo_path = repo_path.to_path_buf();
        let worktree_path = worktree_path.to_path_buf();
        let branch = branch.to_string();
        let remote = remote.to_string();

        tokio::task::spawn_blocking(move || {
            let remote_ref = format!("{}/{}", remote, branch);

            // Check if local branch exists
            let local_exists = git_rev_parse(&repo_path, &format!("refs/heads/{}", branch))?;

            // Check if remote branch exists
            let remote_exists = git_rev_parse(&repo_path, &format!("refs/remotes/{}", remote_ref))?;

            if local_exists {
                // Local branch exists - just checkout
                git_cmd(
                    &repo_path,
                    &["worktree", "add", &worktree_path.to_string_lossy(), &branch],
                )?;

                // Set upstream if remote exists
                if remote_exists {
                    let _ = git_cmd(
                        &worktree_path,
                        &["branch", "--set-upstream-to", &remote_ref, &branch],
                    );
                }
            } else if remote_exists {
                // Remote exists - create tracking branch
                git_cmd(
                    &repo_path,
                    &[
                        "worktree",
                        "add",
                        "--track",
                        "-b",
                        &branch,
                        &worktree_path.to_string_lossy().as_ref(),
                        &remote_ref,
                    ],
                )?;
            } else {
                // Neither - create new branch
                git_cmd(
                    &repo_path,
                    &[
                        "worktree",
                        "add",
                        "-b",
                        &branch,
                        &worktree_path.to_string_lossy().as_ref(),
                    ],
                )?;
            }

            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("worktree task panicked")??;

        Ok(())
    }

    /// Remove worktree
    pub async fn remove_worktree(&self, repo_path: &Path, worktree_path: &Path) -> Result<()> {
        let repo_path = repo_path.to_path_buf();
        let worktree_path = worktree_path.to_path_buf();

        tokio::task::spawn_blocking(move || {
            git_cmd(
                &repo_path,
                &[
                    "worktree",
                    "remove",
                    &worktree_path.to_string_lossy(),
                    "--force",
                ],
            )
        })
        .await
        .context("remove worktree task panicked")??;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Status (using gix where possible, CLI for ahead/behind)
    // ─────────────────────────────────────────────────────────────

    /// Get git status for worktree
    pub fn get_status(&self, worktree_path: &Path) -> Result<GitStatus> {
        let repo = gix::open(worktree_path).context("failed to open repository")?;

        // Current branch
        let branch = match repo.head_name() {
            Ok(Some(name)) => name.shorten().to_string(),
            _ => "HEAD".to_string(),
        };

        // HEAD commit
        let head = repo
            .head_commit()
            .ok()
            .map(|c| c.id().to_string());

        // Commit message
        let commit_message = repo
            .head_commit()
            .ok()
            .and_then(|c| {
                use gix::bstr::ByteSlice;
                c.message_raw()
                    .ok()
                    .and_then(|m| m.lines().next())
                    .map(|line| String::from_utf8_lossy(line).to_string())
            });

        // Dirty check using gix
        let dirty = repo.is_dirty().unwrap_or(false);

        // Ahead/behind (still use CLI - gix doesn't have easy API for this)
        let (ahead, behind) = self
            .git_output(
                worktree_path,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("origin/{}...HEAD", branch),
                ],
            )
            .ok()
            .and_then(|output| {
                let parts: Vec<&str> = output.trim().split_whitespace().collect();
                if parts.len() == 2 {
                    Some((
                        parts[1].parse().unwrap_or(0),
                        parts[0].parse().unwrap_or(0),
                    ))
                } else {
                    None
                }
            })
            .unwrap_or((0, 0));

        Ok(GitStatus {
            branch,
            head,
            dirty,
            ahead,
            behind,
            commit_message,
        })
    }

    /// Detect default branch from remote HEAD
    pub fn detect_default_branch(&self, repo_path: &Path) -> Result<String> {
        let repo = gix::open(repo_path).context("failed to open repository")?;

        // Try to get origin/HEAD symbolic ref
        if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
            if let Some(target) = reference.target().try_name() {
                let name = target.to_string();
                if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                    return Ok(branch.to_string());
                }
            }
        }

        // Fallback to CLI
        let output = self.git_output(
            repo_path,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        )?;

        let branch = output
            .trim()
            .strip_prefix("origin/")
            .unwrap_or(output.trim());

        if branch.is_empty() {
            Ok("main".to_string())
        } else {
            Ok(branch.to_string())
        }
    }

    /// Pull latest changes
    pub async fn pull(&self, worktree_path: &Path) -> Result<()> {
        self.git(worktree_path, &["pull", "--ff-only"])?;
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────

    /// Run git command
    fn git(&self, cwd: &Path, args: &[&str]) -> Result<()> {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .with_context(|| format!("failed to execute git {}", args.join(" ")))?;

        if !output.status.success() {
            bail!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(())
    }

    /// Run git command and capture output
    fn git_output(&self, cwd: &Path, args: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .with_context(|| format!("failed to execute git {}", args.join(" ")))?;

        if !output.status.success() {
            bail!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

impl Default for GitOps {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────
// Standalone Git Helpers (for use in spawn_blocking)
// ─────────────────────────────────────────────────────────────

/// Run git command (standalone version for spawn_blocking)
fn git_cmd(cwd: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to execute git {}", args.join(" ")))?;

    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

/// Check if ref exists (standalone version for spawn_blocking)
fn git_rev_parse(repo_path: &Path, refspec: &str) -> Result<bool> {
    let output = Command::new("git")
        .args(["rev-parse", "--verify", refspec])
        .current_dir(repo_path)
        .output()
        .context("failed to execute git rev-parse")?;

    Ok(output.status.success())
}

// ─────────────────────────────────────────────────────────────
// File Sharing
// ─────────────────────────────────────────────────────────────

/// Share files between worktrees (symlinks and copies)
/// Patterns use glob syntax (e.g., ".env", ".env.*", ".claude/**")
pub fn share_files(
    source: &Path,
    target: &Path,
    symlink_patterns: &[&str],
    copy_patterns: &[&str],
) -> Result<()> {
    use std::fs;
    use std::os::unix::fs::symlink;

    // Collect all files recursively
    fn collect_files(dir: &Path, base: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(base).unwrap_or(&path);
            let relative_str = relative.to_string_lossy();

            // Skip .git
            if relative_str.contains(".git") {
                continue;
            }

            if path.is_dir() {
                collect_files(&path, base, files)?;
            } else {
                files.push(relative_str.to_string());
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect_files(source, source, &mut files)?;

    for file in files {
        let source_full = source.join(&file);
        let target_full = target.join(&file);

        // Check if matches any pattern
        let should_symlink = symlink_patterns
            .iter()
            .any(|pattern| glob_match(pattern, &file));
        let should_copy = copy_patterns
            .iter()
            .any(|pattern| glob_match(pattern, &file));

        if !should_symlink && !should_copy {
            continue;
        }

        // Skip if target already exists
        if target_full.exists() {
            continue;
        }

        // Ensure parent directory exists
        if let Some(parent) = target_full.parent() {
            fs::create_dir_all(parent)?;
        }

        if should_symlink {
            symlink(&source_full, &target_full)?;
        } else if should_copy {
            fs::copy(&source_full, &target_full)?;
        }
    }

    Ok(())
}

/// Simple glob matching (supports * and **)
fn glob_match(pattern: &str, path: &str) -> bool {
    // Handle ** (match any path)
    if pattern.contains("**") {
        let parts: Vec<&str> = pattern.split("**").collect();
        if parts.len() == 2 {
            let prefix = parts[0].trim_end_matches('/');
            let suffix = parts[1].trim_start_matches('/');

            if !prefix.is_empty() && !path.starts_with(prefix) {
                return false;
            }
            if !suffix.is_empty() && !path.ends_with(suffix) {
                return false;
            }
            return true;
        }
    }

    // Handle single * (match within component)
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            return path.starts_with(parts[0]) && path.ends_with(parts[1]);
        }
    }

    // Exact match
    pattern == path
}

// ─────────────────────────────────────────────────────────────
// URL Parsing
// ─────────────────────────────────────────────────────────────

/// Parse git URL into components
fn parse_git_url(url: &str) -> Option<ParsedGitUrl> {
    // SSH format: git@github.com:user/repo.git
    if let Some(rest) = url.strip_prefix("git@") {
        let parts: Vec<&str> = rest.splitn(2, ':').collect();
        if parts.len() == 2 {
            let provider = extract_provider(parts[0]);
            let path = parts[1].trim_end_matches(".git");
            let path_parts: Vec<&str> = path.splitn(2, '/').collect();
            if path_parts.len() == 2 {
                return Some(ParsedGitUrl {
                    provider,
                    username: path_parts[0].to_string(),
                    name: path_parts[1].to_string(),
                    url: url.to_string(),
                });
            }
        }
    }

    // HTTPS format: https://github.com/user/repo.git
    if url.starts_with("https://") || url.starts_with("http://") {
        if let Ok(parsed) = url::Url::parse(url) {
            let provider = extract_provider(parsed.host_str().unwrap_or(""));
            let path = parsed.path().trim_start_matches('/').trim_end_matches(".git");
            let path_parts: Vec<&str> = path.splitn(2, '/').collect();
            if path_parts.len() == 2 {
                return Some(ParsedGitUrl {
                    provider,
                    username: path_parts[0].to_string(),
                    name: path_parts[1].to_string(),
                    url: url.to_string(),
                });
            }
        }
    }

    None
}

fn extract_provider(host: &str) -> String {
    if host.contains("github") {
        "github".to_string()
    } else if host.contains("gitlab") {
        "gitlab".to_string()
    } else if host.contains("bitbucket") {
        "bitbucket".to_string()
    } else {
        host.split('.').next().unwrap_or("unknown").to_string()
    }
}
