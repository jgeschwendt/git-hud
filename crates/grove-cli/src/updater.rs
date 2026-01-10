//! Auto-update functionality
//!
//! Checks for updates when running `grove` or `grove server`.

use anyhow::Result;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const REPO: &str = "jgeschwendt/grove";

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
    let resp: serde_json::Value = client
        .get(&url)
        .header("User-Agent", "grove-cli")
        .send()
        .await?
        .json()
        .await?;

    resp.get("tag_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("No tag_name in release"))
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
async fn download_update(client: &reqwest::Client, version: &str) -> Result<()> {
    let url = get_download_url(version);
    tracing::debug!("Downloading update from {}", url);

    let resp = client
        .get(&url)
        .header("User-Agent", "grove-cli")
        .send()
        .await?;

    if !resp.status().is_success() {
        anyhow::bail!("Download failed: HTTP {}", resp.status());
    }

    let bytes = resp.bytes().await?;

    // Extract tarball to temp location
    let tmp_dir = std::env::temp_dir().join(format!("grove-update-{}", std::process::id()));
    fs::create_dir_all(&tmp_dir)?;

    let tar_path = tmp_dir.join("grove.tar.gz");
    fs::write(&tar_path, &bytes)?;

    // Extract using tar command
    let output = std::process::Command::new("tar")
        .args(["-xzf", tar_path.to_str().unwrap(), "-C", tmp_dir.to_str().unwrap()])
        .output()?;

    if !output.status.success() {
        let _ = fs::remove_dir_all(&tmp_dir);
        anyhow::bail!("Failed to extract tarball");
    }

    // Move extracted binary to staged location
    let extracted = tmp_dir.join("grove");
    let staged = staged_binary_path();

    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::copy(&extracted, &staged)?;

    // Cleanup temp dir
    let _ = fs::remove_dir_all(&tmp_dir);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&staged)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&staged, perms)?;
    }

    tracing::info!("Update {} staged at {:?}", version, staged);
    Ok(())
}

/// Apply staged update by swapping binaries
pub fn apply_staged_update() -> Result<bool> {
    let staged = staged_binary_path();
    if !staged.exists() {
        return Ok(false);
    }

    let current = std::env::current_exe()?;
    // Resolve symlinks to get actual binary path
    let current = current.canonicalize().unwrap_or(current);

    // Backup current binary (in same dir to avoid cross-device issues)
    let backup = current.with_extension("old");
    if backup.exists() {
        fs::remove_file(&backup)?;
    }

    // Move current -> backup
    fs::rename(&current, &backup)?;

    // Copy staged -> current (copy works cross-device, rename doesn't)
    match fs::copy(&staged, &current) {
        Ok(_) => {
            // Set executable permission
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&current)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&current, perms)?;
            }

            // Remove backup and staged on success
            let _ = fs::remove_file(&backup);
            let _ = fs::remove_file(&staged);
            tracing::info!("Update applied successfully");
            Ok(true)
        }
        Err(e) => {
            // Restore backup on failure
            let _ = fs::rename(&backup, &current);
            Err(e.into())
        }
    }
}

/// Check for updates and download in background (non-blocking)
pub fn check_for_updates_background() {
    // First, apply any staged update
    match apply_staged_update() {
        Ok(true) => {
            eprintln!("\x1b[32minfo\x1b[0m: grove updated! Restart to use new version.");
        }
        Ok(false) => {}
        Err(e) => {
            tracing::debug!("Failed to apply staged update: {}", e);
        }
    }

    // Spawn background task to check for updates
    tokio::spawn(async move {
        if let Err(e) = check_and_download().await {
            tracing::debug!("Update check failed: {}", e);
        }
    });
}

/// Perform the actual update check and download
async fn check_and_download() -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let latest = get_latest_version(&client).await?;
    let current = current_version();

    tracing::debug!("Current: {}, Latest: {}", current, latest);

    if is_newer(&latest, current) {
        tracing::info!("New version available: {} -> {}", current, latest);
        download_update(&client, &latest).await?;
    }

    Ok(())
}
