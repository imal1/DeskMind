//! The API key, kept in the Windows Credential Manager rather than in
//! `config.json`.
//!
//! Two reasons. The design promises it ("只存在本机凭据库，不随配置同步"), and
//! `config.json` is a file users are encouraged to read, hand-edit and share —
//! exactly the wrong place for a secret. Everything else stays in the file.

use crate::config::Config;

const SERVICE: &str = "deskmind";
const ACCOUNT: &str = "api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Empty when no key has been stored. Callers treat empty as "not configured";
/// a missing entry is not an error worth surfacing.
pub fn api_key() -> String {
    entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default()
}

pub fn set_api_key(value: &str) -> Result<(), String> {
    entry()?.set_password(value).map_err(|e| e.to_string())
}

pub fn has_key() -> bool {
    !api_key().trim().is_empty()
}

/// Moves a key written by an earlier version out of `config.json` and into the
/// credential store, then blanks the field. Returns whether the config needs
/// saving.
///
/// The user should never have to paste their key again because we changed where
/// it lives.
pub fn migrate(cfg: &mut Config) -> bool {
    let stale = cfg.api_key.trim();
    if stale.is_empty() {
        return false;
    }
    // Only clear the file once the credential store has actually taken it —
    // losing the key to a failed write would be worse than leaving it in plaintext.
    match set_api_key(stale) {
        Ok(()) => {
            cfg.api_key = String::new();
            true
        }
        Err(err) => {
            eprintln!("迁移 API key 到凭据管理器失败，暂时留在配置文件里：{err}");
            false
        }
    }
}
