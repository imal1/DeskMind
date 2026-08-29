//! Configuration on disk: `%APPDATA%\deskmind\config.json`.
//!
//! Written as readable JSON on purpose — the target users are people who will
//! want to edit it by hand and share it (see ADR 0011 on the choice of JSON over
//! SQLite).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    /// Only ever a migration inbox. Versions before the credential store existed
    /// wrote the key here; `secrets::migrate` moves it out and blanks it. Nothing
    /// reads it for normal operation — see `secrets::api_key`.
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    /// Background treatment: `fog`, `highlight` or `none`.
    pub effect: String,
    /// Set once the user has been through the first-run flow, so it never shows
    /// twice. Distinct from "has a key": someone may finish onboarding by
    /// declining the AI entirely.
    pub onboarded: bool,
    /// When the last tidy succeeded, in milliseconds since the epoch. Zero means
    /// never — the status panel shows no time at all rather than claiming a tidy
    /// that never happened. Milliseconds because the only reader is `Date` in the
    /// webview.
    pub last_tidy: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            // DeepSeek speaks the OpenAI wire format, so switching provider is a
            // matter of changing these two strings.
            model: "deepseek-chat".into(),
            base_url: "https://api.deepseek.com/chat/completions".into(),
            effect: "highlight".into(),
            onboarded: false,
            last_tidy: 0,
        }
    }
}

pub fn dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("deskmind"))
}

pub fn path() -> Option<PathBuf> {
    Some(dir()?.join("config.json"))
}

/// Reads the config, creating it with defaults if absent.
pub fn load() -> Config {
    let Some(file) = path() else {
        return Config::default();
    };
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
            return cfg;
        }
    }
    let fresh = Config::default();
    let _ = save(&fresh);
    fresh
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let file = path().ok_or("找不到配置目录")?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_falls_back_to_defaults_per_field() {
        let cfg: Config = serde_json::from_str(r#"{"api_key":"sk-x"}"#).unwrap();
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.model, "deepseek-chat");
        assert!(cfg.base_url.contains("deepseek"));
    }
}
