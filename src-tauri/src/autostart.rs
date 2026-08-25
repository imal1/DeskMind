//! Launching with Windows, via the per-user Run key.
//!
//! `HKCU\...\Run` rather than a scheduled task or the machine-wide key: it needs
//! no elevation, and deskmind is a per-user tool — one user enabling it should
//! not start it for everyone on the machine.

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "deskmind";

fn exe_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Quoted: Program Files and user names both contain spaces.
    Ok(format!("\"{}\"", exe.to_string_lossy()))
}

pub fn enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(VALUE))
        .is_ok()
}

pub fn set(on: bool) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_WRITE)
        .map_err(|e| e.to_string())?;
    if on {
        key.set_value(VALUE, &exe_command()?)
            .map_err(|e| e.to_string())
    } else {
        match key.delete_value(VALUE) {
            Ok(()) => Ok(()),
            // Already absent is the desired end state, not a failure.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn exe_command_is_quoted_and_absolute() {
        let cmd = exe_command().unwrap();
        assert!(cmd.starts_with('"') && cmd.ends_with('"'));
        assert!(cmd.contains(":\\"), "expected an absolute path, got {cmd}");
    }

    #[test]
    fn disabling_twice_is_not_an_error() {
        // Leaves the machine as it found it: only runs when already disabled.
        if !enabled() {
            assert!(set(false).is_ok());
            assert!(set(false).is_ok());
        }
    }
}
