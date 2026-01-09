//! Configuration for grove

use std::path::PathBuf;

/// Grove configuration
#[derive(Debug, Clone)]
pub struct Config {
    /// Directory where repositories are cloned
    pub code_dir: PathBuf,
    /// Directory for grove data (database, etc.)
    pub data_dir: PathBuf,
    /// Database file path
    pub db_path: PathBuf,
}

impl Config {
    /// Create config from environment or defaults
    pub fn from_env() -> Self {
        let home = dirs::home_dir().expect("could not determine home directory");

        let grove_root = std::env::var("GROVE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".grove"));

        let code_dir = std::env::var("GROVE_CODE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("code"));

        let data_dir = grove_root.join("data");
        let db_path = data_dir.join("repos.db");

        Self {
            code_dir,
            data_dir,
            db_path,
        }
    }

    /// Ensure all directories exist
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.code_dir)?;
        std::fs::create_dir_all(&self.data_dir)?;
        Ok(())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_env()
    }
}
