//! Auto-update functionality
//!
//! Checks for updates when running `grove` or `grove server`.
//! Logs to ~/.grove/data/updater.log

use anyhow::Result;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

const REPO: &str = "jgeschwendt/grove";

/// Log a message to the updater log file
fn log(msg: &str) {
    let log_path = grove_home().join("data").join("updater.log");
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

/// Get the grove home directory (~/.grove)
fn grove_home() -> PathBuf {
    std::env::var("GROVE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".grove")
        })
}

/// Get user's home directory
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Path to staged update binary
fn staged_binary_path() -> PathBuf {
    grove_home().join("bin").join("grove.new")
}

/// Get current version from build info
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Parse version string to comparable tuple
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() >= 3 {
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    } else {
        None
    }
}

/// Check if version a is newer than version b
fn is_newer(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Get latest release version from GitHub
async fn get_latest_version(client: &reqwest::Client) -> Result<String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", REPO);
    let resp = match client
        .get(&url)
        .header("User-Agent", "grove-cli")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log(&format!("ERROR: GitHub API request failed: {}", e));
            anyhow::bail!("GitHub API request failed: {}", e);
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            log(&format!("ERROR: Failed to parse GitHub API response: {}", e));
            anyhow::bail!("Failed to parse GitHub API response: {}", e);
        }
    };

    json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| {
            log("ERROR: No tag_name in GitHub release response");
            anyhow::anyhow!("No tag_name in release")
        })
}

/// Get download URL for current platform
fn get_download_url(version: &str) -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "unknown"
    };

    format!(
        "https://github.com/{}/releases/download/{}/{}-{}.tar.gz",
        REPO, version, os, arch
    )
}

/// Download and stage new binary
async fn download_update(_client: &reqwest::Client, version: &str) -> Result<()> {
    let url = get_download_url(version);
    log(&format!("Downloading update from {}", url));

    // Use a separate client with longer timeout for downloads
    let download_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    let resp = match download_client
        .get(&url)
        .header("User-Agent", "grove-cli")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log(&format!("ERROR: HTTP request failed: {}", e));
            anyhow::bail!("HTTP request failed: {}", e);
        }
    };

    if !resp.status().is_success() {
        log(&format!("ERROR: Download failed with HTTP {}", resp.status()));
        anyhow::bail!("Download failed: HTTP {}", resp.status());
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            log(&format!("ERROR: Failed to read response bytes: {}", e));
            anyhow::bail!("Failed to read response bytes: {}", e);
        }
    };

    // Extract tarball to temp location
    let tmp_dir = std::env::temp_dir().join(format!("grove-update-{}", std::process::id()));
    if let Err(e) = fs::create_dir_all(&tmp_dir) {
        log(&format!("ERROR: Failed to create temp dir {:?}: {}", tmp_dir, e));
        anyhow::bail!("Failed to create temp dir: {}", e);
    }

    let tar_path = tmp_dir.join("grove.tar.gz");
    if let Err(e) = fs::write(&tar_path, &bytes) {
        log(&format!("ERROR: Failed to write tarball to {:?}: {}", tar_path, e));
        let _ = fs::remove_dir_all(&tmp_dir);
        anyhow::bail!("Failed to write tarball: {}", e);
    }

    // Extract using tar command
    let output = match std::process::Command::new("tar")
        .args(["-xzf", tar_path.to_str().unwrap(), "-C", tmp_dir.to_str().unwrap()])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            log(&format!("ERROR: Failed to run tar command: {}", e));
            let _ = fs::remove_dir_all(&tmp_dir);
            anyhow::bail!("Failed to run tar command: {}", e);
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log(&format!("ERROR: tar extraction failed: {}", stderr));
        let _ = fs::remove_dir_all(&tmp_dir);
        anyhow::bail!("Failed to extract tarball: {}", stderr);
    }

    // Move extracted binary to staged location
    let extracted = tmp_dir.join("grove");
    let staged = staged_binary_path();

    if !extracted.exists() {
        log(&format!("ERROR: Extracted binary not found at {:?}", extracted));
        let _ = fs::remove_dir_all(&tmp_dir);
        anyhow::bail!("Extracted binary not found");
    }

    if let Some(parent) = staged.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log(&format!("ERROR: Failed to create staging dir {:?}: {}", parent, e));
            let _ = fs::remove_dir_all(&tmp_dir);
            anyhow::bail!("Failed to create staging dir: {}", e);
        }
    }

    if let Err(e) = fs::copy(&extracted, &staged) {
        log(&format!("ERROR: Failed to copy binary to staged location: {}", e));
        let _ = fs::remove_dir_all(&tmp_dir);
        anyhow::bail!("Failed to stage binary: {}", e);
    }

    // Cleanup temp dir
    let _ = fs::remove_dir_all(&tmp_dir);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(&staged) {
            Ok(meta) => {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                if let Err(e) = fs::set_permissions(&staged, perms) {
                    log(&format!("ERROR: Failed to set executable permissions: {}", e));
                    anyhow::bail!("Failed to set executable permissions: {}", e);
                }
            }
            Err(e) => {
                log(&format!("ERROR: Failed to get staged binary metadata: {}", e));
                anyhow::bail!("Failed to get staged binary metadata: {}", e);
            }
        }
    }

    log(&format!("Update {} staged, will apply on next run", version));
    Ok(())
}

/// Apply staged update by swapping binaries
pub fn apply_staged_update() -> Result<bool> {
    let staged = staged_binary_path();
    if !staged.exists() {
        return Ok(false);
    }

    log("Applying staged update...");

    let current = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("ERROR: Failed to get current exe path: {}", e));
            anyhow::bail!("Failed to get current exe path: {}", e);
        }
    };
    // Resolve symlinks to get actual binary path
    let current = current.canonicalize().unwrap_or(current);
    log(&format!("Current binary: {:?}", current));

    // Backup current binary (in same dir to avoid cross-device issues)
    let backup = current.with_extension("old");
    if backup.exists() {
        if let Err(e) = fs::remove_file(&backup) {
            log(&format!("ERROR: Failed to remove old backup: {}", e));
            anyhow::bail!("Failed to remove old backup: {}", e);
        }
    }

    // Move current -> backup
    if let Err(e) = fs::rename(&current, &backup) {
        log(&format!("ERROR: Failed to backup current binary: {}", e));
        anyhow::bail!("Failed to backup current binary: {}", e);
    }

    // Copy staged -> current (copy works cross-device, rename doesn't)
    match fs::copy(&staged, &current) {
        Ok(_) => {
            // Set executable permission
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                match fs::metadata(&current) {
                    Ok(meta) => {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        if let Err(e) = fs::set_permissions(&current, perms) {
                            log(&format!("ERROR: Failed to set permissions after update: {}", e));
                            let _ = fs::rename(&backup, &current);
                            anyhow::bail!("Failed to set permissions: {}", e);
                        }
                    }
                    Err(e) => {
                        log(&format!("ERROR: Failed to get metadata after update: {}", e));
                        let _ = fs::rename(&backup, &current);
                        anyhow::bail!("Failed to get metadata: {}", e);
                    }
                }
            }

            // Remove backup and staged on success
            let _ = fs::remove_file(&backup);
            let _ = fs::remove_file(&staged);
            log("Update applied successfully");
            Ok(true)
        }
        Err(e) => {
            log(&format!("ERROR: Failed to copy staged binary: {}", e));
            // Restore backup on failure
            let _ = fs::rename(&backup, &current);
            Err(e.into())
        }
    }
}

/// Check for updates and download in background (non-blocking)
/// Returns true if an update was applied (caller should notify user)
pub fn check_for_updates_background() -> bool {
    // First, apply any staged update
    let updated = match apply_staged_update() {
        Ok(true) => true,
        Ok(false) => false,
        Err(e) => {
            log(&format!("Failed to apply staged update: {}", e));
            false
        }
    };

    // Skip update check if we just applied an update.
    // The running binary's version is stale (compiled-in), so it would
    // re-download the same version. Next run will be the new binary.
    if updated {
        log("Skipping update check - just applied staged update");
        return true;
    }

    // Spawn background task to check for updates
    tokio::spawn(async move {
        if let Err(e) = check_and_download().await {
            log(&format!("Update check failed: {}", e));
        }
    });

    updated
}

/// Perform the actual update check and download
async fn check_and_download() -> Result<()> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log(&format!("ERROR: Failed to create HTTP client: {}", e));
            anyhow::bail!("Failed to create HTTP client: {}", e);
        }
    };

    let latest = match get_latest_version(&client).await {
        Ok(v) => v,
        Err(e) => {
            log(&format!("ERROR: Failed to get latest version: {}", e));
            return Err(e);
        }
    };
    let current = current_version();

    log(&format!("Version check: current={}, latest={}", current, latest));

    if is_newer(&latest, current) {
        log(&format!("New version available: {} -> {}", current, latest));
        download_update(&client, &latest).await?;
    }

    Ok(())
}
