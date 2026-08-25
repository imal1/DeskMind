//! Resolving `.lnk` files to the program they point at.
//!
//! This exists purely so icon extraction can work on the real executable.
//! `systemicons` only reads the actual file when the path ends in `.exe`;
//! for anything else it falls back to a lookup by extension, which for a
//! shortcut yields the generic "shortcut" glyph with the overlay arrow.

use lnk::ShellLink;
use std::path::Path;

/// Returns the target path of a shortcut, or `None` if it has no resolvable
/// target. Shortcuts to Store apps and MSI-advertised entries legitimately have
/// no filesystem target — callers fall back to the `.lnk` itself.
pub fn resolve(lnk_path: &str) -> Option<String> {
    // The encoding argument only applies to shortcuts written before Unicode
    // string data became standard. GBK is the right ANSI code page guess on a
    // Chinese Windows install; modern shortcuts ignore it entirely.
    let link = ShellLink::open(Path::new(lnk_path), encoding_rs::GBK).ok()?;
    let target = link.link_target()?;
    if target.trim().is_empty() {
        None
    } else {
        Some(target)
    }
}

pub fn is_shortcut(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_check_is_case_insensitive() {
        assert!(is_shortcut(r"C:\x\Foo.lnk"));
        assert!(is_shortcut(r"C:\x\Foo.LNK"));
        assert!(!is_shortcut(r"C:\x\Foo.exe"));
        assert!(!is_shortcut(r"C:\x\Foo"));
    }

    #[test]
    fn unparseable_file_resolves_to_none() {
        assert!(resolve(r"C:\definitely\not\here.lnk").is_none());
    }
}
