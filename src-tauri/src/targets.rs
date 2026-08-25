//! Enumerating launch targets — installed programs plus whatever is on the
//! desktop. Sources are the two Start Menu shortcut trees and the desktop
//! folders. Nothing here touches icons; see the tile work for that.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct LaunchTarget {
    /// What the user sees. For shortcuts this is the file stem, not the target.
    pub name: String,
    /// What gets launched. Shortcuts are launched as-is; the shell resolves them.
    pub path: String,
    pub source: &'static str,
}

/// Every Start Menu is full of these. They are not things people launch, and
/// leaving them in distorts both the UI and the AI grouping. Matched
/// case-insensitively against the display name.
const JUNK: &[&str] = &[
    "卸载",
    "uninstall",
    "帮助",
    "readme",
    "说明文档",
    "官网",
    "website",
    "documentation",
    "license",
    "反馈",
    "feedback",
    "changelog",
    "change log",
    "修复",
    "repair",
];

fn is_junk(name: &str) -> bool {
    let lower = name.to_lowercase();
    JUNK.iter().any(|j| lower.contains(j))
}

fn start_menus() -> Vec<PathBuf> {
    ["ProgramData", "APPDATA"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .map(|base| {
            PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs")
        })
        .collect()
}

fn desktops() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // dirs::desktop_dir goes through SHGetKnownFolderPath, so it follows the
    // redirection OneDrive sets up — a plain %USERPROFILE%\Desktop would miss it.
    if let Some(d) = dirs::desktop_dir() {
        dirs.push(d);
    }
    if let Some(public) = std::env::var_os("PUBLIC") {
        dirs.push(PathBuf::from(public).join("Desktop"));
    }
    dirs
}

/// Walks `dir` for shortcuts. Start Menu trees are shallow (two or three
/// levels), so plain recursion is fine and needs no depth guard.
fn collect_shortcuts(dir: &Path, source: &'static str, out: &mut Vec<LaunchTarget>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_shortcuts(&path, source, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()).map(str::to_lowercase)
            != Some("lnk".into())
        {
            continue;
        }
        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
            out.push(LaunchTarget {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
                source,
            });
        }
    }
}

/// Desktop contents are taken at one level only — a folder on the desktop is
/// itself a launch target, we do not descend into it.
fn collect_desktop(dir: &Path, out: &mut Vec<LaunchTarget>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let is_lnk = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
        let name = if is_lnk {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name)
        } else {
            file_name
        };
        out.push(LaunchTarget {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            source: "desktop",
        });
    }
}

pub fn scan() -> Vec<LaunchTarget> {
    let mut found = Vec::new();

    for dir in start_menus() {
        collect_shortcuts(&dir, "startmenu", &mut found);
    }
    for dir in desktops() {
        collect_desktop(&dir, &mut found);
    }

    // Two Start Menu trees plus the desktop routinely hold the same program.
    // Keep the first sighting; desktop entries lose to Start Menu ones only by
    // accident of order, which does not matter while nothing depends on `path`
    // beyond launching.
    let mut seen = HashSet::new();
    let mut out: Vec<LaunchTarget> = found
        .into_iter()
        .filter(|t| !t.name.trim().is_empty() && !is_junk(&t.name))
        .filter(|t| seen.insert(t.name.to_lowercase()))
        .collect();

    out.sort_by_key(|t| t.name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_filter_catches_both_languages() {
        assert!(is_junk("卸载 Visual Studio Code"));
        assert!(is_junk("Uninstall Foo"));
        assert!(is_junk("Pandoc User's Guide documentation"));
        assert!(!is_junk("Visual Studio Code"));
        assert!(!is_junk("微信"));
    }

    #[test]
    fn scan_dedupes_by_name_and_sorts() {
        // Exercises the real machine; asserts only invariants that must hold
        // regardless of what is installed.
        let out = scan();
        let mut names: Vec<String> = out.iter().map(|t| t.name.to_lowercase()).collect();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "scan returned duplicate names");
        assert!(out.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));
    }
}
