//! Icon extraction and caching.
//!
//! Three attempts in decreasing fidelity, because no single one covers every
//! launch target:
//!
//! 1. `shellicon` — asks the shell about the file itself. Resolves shortcuts of
//!    every kind and returns the real icon with no overlay arrow.
//! 2. the shortcut's target, via `systemicons` — for anything the shell declined.
//! 3. `systemicons` on the original path — may be a generic glyph, but a generic
//!    glyph beats an empty plate.

use crate::{shellicon, shortcut};
use base64::Engine;
use std::collections::HashMap;
use std::sync::Mutex;

/// Extraction goes through the shell and costs a few milliseconds per file, so
/// results are kept for the process lifetime. Icons only change when a program
/// is reinstalled, which is well outside a single session.
#[derive(Default)]
pub struct IconCache(Mutex<HashMap<String, String>>);

/// Requested edge length in pixels. Tiles draw smaller than this; asking for
/// more than we display keeps them crisp on scaled displays.
const SIZE: i32 = 64;

fn extract(path: &str) -> Option<String> {
    // Ask the shell about the file itself first. That resolves shortcuts —
    // including Store and MSI-advertised ones, which have no filesystem target
    // for the `lnk` crate to find — and returns the program's own icon with no
    // overlay arrow.
    let bytes = shellicon::png_of(path).or_else(|| {
        // Fallbacks, in decreasing fidelity: the shortcut's target if we can read
        // it, then whatever `systemicons` makes of the path. The last one may be a
        // generic glyph, which still beats an empty plate.
        let resolved = shortcut::is_shortcut(path)
            .then(|| shortcut::resolve(path))
            .flatten();
        let subject = resolved.as_deref().unwrap_or(path);
        systemicons::get_icon(subject, SIZE).ok()
    })?;

    if bytes.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// Resolves many paths in one call. One IPC round trip per launchpad open beats
/// one per tile — with 140 targets the difference is visible.
///
/// Paths that fail are omitted rather than reported: a missing icon is a cosmetic
/// problem the frontend already has to handle, and a broken shortcut should not
/// fail the whole batch.
pub fn batch(cache: &IconCache, paths: Vec<String>) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(paths.len());

    // Serve what is already cached without holding the lock across extraction.
    let mut misses = Vec::new();
    {
        let map = cache.0.lock().expect("icon cache poisoned");
        for path in paths {
            match map.get(&path) {
                Some(url) => {
                    out.insert(path, url.clone());
                }
                None => misses.push(path),
            }
        }
    }

    let fresh: Vec<(String, String)> = misses
        .into_iter()
        .filter_map(|path| extract(&path).map(|url| (path, url)))
        .collect();

    if !fresh.is_empty() {
        let mut map = cache.0.lock().expect("icon cache poisoned");
        for (path, url) in fresh {
            map.insert(path.clone(), url.clone());
            out.insert(path, url);
        }
    }

    out
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    const REAL: &str = r"C:\Windows\notepad.exe";
    const BOGUS: &str = r"C:\definitely\not\here.lnk";

    /// Note that a missing file does **not** produce nothing: the last fallback,
    /// `systemicons`, answers with SHELL32's default icon. So a broken shortcut
    /// shows a generic glyph rather than an empty plate, and the icon count the UI
    /// reports includes those fallbacks — it is not a measure of how many real
    /// icons were found.
    #[test]
    fn a_bad_path_does_not_fail_the_batch() {
        let cache = IconCache::default();
        let out = batch(&cache, vec![BOGUS.into(), REAL.into()]);
        assert!(out.contains_key(REAL), "a bad path took the good one down with it");
    }

    #[test]
    fn second_call_is_served_from_cache() {
        let cache = IconCache::default();
        let first = batch(&cache, vec![REAL.into()]);
        assert!(!first.is_empty());
        let cached = cache.0.lock().unwrap().len();
        let second = batch(&cache, vec![REAL.into()]);
        assert_eq!(first, second);
        assert_eq!(cached, first.len());
    }
}
