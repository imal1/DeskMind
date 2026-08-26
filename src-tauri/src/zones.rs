//! Zones and their membership, persisted to `%APPDATA%\deskmind\zones.json`.
//!
//! Membership is keyed by launch-target **path**, not by display name: names are
//! what the model reasons about, but paths are what survives a program being
//! renamed in the Start Menu.
//!
//! Per ADR 0009 the zone set belongs to the user. Nothing here creates or deletes
//! zones on the model's behalf except the first-run suggestion, which arrives as
//! an explicit whole-set write.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Zone {
    pub name: String,
    /// Launch-target paths belonging to this zone.
    pub items: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Zones {
    pub zones: Vec<Zone>,
    /// Launch-target paths the user marked as frequently used. Kept alongside the
    /// zones rather than in its own file: both describe the same thing, how the
    /// user has organised their launch targets. `serde(default)` means a
    /// zones.json written before pinning existed still loads.
    pub pinned: Vec<String>,
    /// Paths the user dropped in from Explorer, which the two scanned sources
    /// would never turn up on their own.
    ///
    /// A drop **adds a launch target and records its path** — the file itself is
    /// not moved, copied or renamed, so this stays on the right side of ADR 0004.
    /// The alternative reading, "file it into the zone", is a file operation
    /// wearing an organisation costume, and the zone is not a folder.
    ///
    /// Owned by the backend: the webview never sends this field back, so
    /// `write_zones` carries it across rather than trusting the round trip.
    pub added: Vec<String>,
}

fn file() -> Option<std::path::PathBuf> {
    Some(crate::config::dir()?.join("zones.json"))
}

pub fn load() -> Zones {
    let Some(path) = file() else {
        return Zones::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(zones: &Zones) -> Result<(), String> {
    let path = file().ok_or("找不到配置目录")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(zones).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Rewrites membership from a `name -> zone name` decision, keeping the existing
/// zone set and order. Names the model invented that match no target are dropped;
/// targets it failed to place keep whatever zone they already had, so a partial
/// answer degrades instead of scattering the user's layout.
pub fn apply(
    existing: &Zones,
    by_name: &HashMap<String, String>,
    name_to_path: &HashMap<String, String>,
) -> Zones {
    let mut placed: HashMap<String, String> = HashMap::new();
    for (name, zone_name) in by_name {
        if let Some(path) = name_to_path.get(name) {
            placed.insert(path.clone(), zone_name.clone());
        }
    }

    let mut out = Zones {
        zones: existing
            .zones
            .iter()
            .map(|z| Zone {
                name: z.name.clone(),
                items: Vec::new(),
            })
            .collect(),
        // Pins are the user's own marks; a tidy re-files things, it does not
        // decide what matters to them.
        pinned: existing.pinned.clone(),
        // Same reasoning: a tidy decides zone membership, not what exists.
        added: existing.added.clone(),
    };

    // Anything the model did not place stays where it was.
    for zone in &existing.zones {
        for path in &zone.items {
            if !placed.contains_key(path) {
                placed.insert(path.clone(), zone.name.clone());
            }
        }
    }

    for (path, zone_name) in placed {
        if let Some(zone) = out.zones.iter_mut().find(|z| z.name == zone_name) {
            zone.items.push(path);
        }
    }

    for zone in &mut out.zones {
        zone.items.sort();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zones() -> Zones {
        Zones {
            zones: vec![
                Zone { name: "开发".into(), items: vec![r"C:\a.lnk".into()] },
                Zone { name: "游戏".into(), items: vec![r"C:\b.lnk".into()] },
            ],
            pinned: vec![r"C:\a.lnk".into()],
            added: vec![r"C:\dropped.txt".into()],
        }
    }

    #[test]
    fn tidy_never_touches_pins() {
        let decision = HashMap::from([("A".to_string(), "游戏".to_string())]);
        let out = apply(&zones(), &decision, &names());
        assert_eq!(out.pinned, vec![r"C:\a.lnk".to_string()]);
    }

    fn names() -> HashMap<String, String> {
        HashMap::from([
            ("A".into(), r"C:\a.lnk".into()),
            ("B".into(), r"C:\b.lnk".into()),
        ])
    }

    #[test]
    fn moves_a_target_between_zones() {
        let decision = HashMap::from([("A".to_string(), "游戏".to_string())]);
        let out = apply(&zones(), &decision, &names());
        assert!(out.zones[0].items.is_empty());
        assert_eq!(out.zones[1].items.len(), 2);
    }

    #[test]
    fn unplaced_targets_keep_their_zone() {
        let out = apply(&zones(), &HashMap::new(), &names());
        assert_eq!(out.zones[0].items, vec![r"C:\a.lnk".to_string()]);
        assert_eq!(out.zones[1].items, vec![r"C:\b.lnk".to_string()]);
    }

    #[test]
    fn invented_zone_names_are_ignored_not_created() {
        let decision = HashMap::from([("A".to_string(), "模型编的分区".to_string())]);
        let out = apply(&zones(), &decision, &names());
        assert_eq!(out.zones.len(), 2, "apply must never create a zone");
        // A was aimed at a zone that does not exist, so it lands nowhere.
        assert!(out.zones.iter().all(|z| !z.items.contains(&r"C:\a.lnk".to_string())));
    }

    #[test]
    fn tidy_keeps_dropped_in_targets() {
        let decision = HashMap::from([("A".to_string(), "游戏".to_string())]);
        let out = apply(&zones(), &decision, &names());
        assert_eq!(out.added, vec![r"C:\dropped.txt".to_string()]);
    }

    #[test]
    fn unknown_names_from_the_model_are_dropped() {
        let decision = HashMap::from([("不存在的程序".to_string(), "开发".to_string())]);
        let out = apply(&zones(), &decision, &names());
        let total: usize = out.zones.iter().map(|z| z.items.len()).sum();
        assert_eq!(total, 2);
    }
}
