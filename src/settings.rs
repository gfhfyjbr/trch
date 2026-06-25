//! Persistent user settings (translation target language + "self" nicknames).
//!
//! Stored as JSON in the Tauri app config directory so it survives restarts.
//! Field names are camelCase to mirror the Solid store keys on the frontend
//! (`targetLang`, `selfNames`).

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "targetLang", default = "default_target")]
    pub target_lang: String,
    #[serde(rename = "selfNames", default)]
    pub self_names: Vec<String>,
}

fn default_target() -> String {
    "English".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            target_lang: default_target(),
            self_names: Vec::new(),
        }
    }
}

/// Load settings from `path`. Missing or malformed files yield defaults so the
/// app always starts cleanly.
pub fn load(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// Persist settings to `path`, creating the parent directory if needed.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
