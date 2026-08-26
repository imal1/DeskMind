mod autostart;
mod config;
mod desktop;
mod icons;
mod secrets;
mod shellicon;
mod shortcut;
mod targets;
mod theme;
mod tidy;
mod zones;

use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WebviewWindow,
};

const DESKTOP: &str = "desktop";

#[tauri::command]
fn list_targets() -> Vec<targets::LaunchTarget> {
    // Dropped-in targets sit outside the two scanned sources, so they have to be
    // merged back in here or they would exist in zones.json and nowhere on screen.
    targets::merge(targets::scan(), targets::from_paths(&zones::load().added))
}

/// Records paths the user dragged in from Explorer as launch targets.
///
/// Adding a target means storing its path, nothing else: no copy into the
/// desktop folder, no move, no rename (ADR 0004). Returns the refreshed target
/// list so the caller does not have to ask twice.
#[tauri::command]
fn add_targets(paths: Vec<String>) -> Result<Vec<targets::LaunchTarget>, String> {
    let mut stored = zones::load();
    for path in paths {
        if !stored.added.contains(&path) {
            stored.added.push(path);
        }
    }
    zones::save(&stored)?;
    Ok(list_targets())
}

/// Undoes an add. Only dropped-in targets can be removed, because only they were
/// ever added — a scanned one would reappear on the next scan.
///
/// Without this a mis-drop could only be undone by deleting the user's actual
/// file, which is precisely what ADR 0004 exists to prevent. Its zone membership
/// and pin go with it, or they would linger as entries pointing at nothing.
#[tauri::command]
fn remove_target(path: String) -> Result<Vec<targets::LaunchTarget>, String> {
    let mut stored = zones::load();
    stored.added.retain(|p| p != &path);
    stored.pinned.retain(|p| p != &path);
    for zone in &mut stored.zones {
        zone.items.retain(|p| p != &path);
    }
    zones::save(&stored)?;
    Ok(list_targets())
}

/// Hands the path to the shell, which resolves `.lnk` files and picks the right
/// handler for plain documents and folders. Deliberately not `Command::new` —
/// that would need per-extension logic and flashes a console window.
#[tauri::command]
fn launch(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| e.to_string())
}

/// Opens the folder a target lives in. Deliberately opens the parent rather than
/// revealing-and-selecting: `opener::open` is already proven here, and "打开所在
/// 文件夹" is exactly what opening the parent does.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let parent = std::path::Path::new(&path)
        .parent()
        .ok_or_else(|| format!("{path} 没有上层目录"))?;
    opener::open(parent).map_err(|e| e.to_string())
}

/// Returns a `path -> data:image/png;base64,…` map. Paths whose icon could not
/// be read are simply absent from the result.
#[tauri::command]
fn icons(paths: Vec<String>, cache: State<icons::IconCache>) -> HashMap<String, String> {
    icons::batch(&cache, paths)
}

#[tauri::command]
fn read_theme(cache: State<theme::ThemeCache>) -> theme::Theme {
    theme::current(&cache)
}

/// Called by the desktop window when it needs the keyboard. `WS_EX_NOACTIVATE`
/// keeps a click from raising the surface over other windows, and the price is
/// that a click never brings the keyboard either — so it is asked for by hand
/// (ADR 0015).
#[tauri::command]
fn grab_focus(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(DESKTOP).ok_or("找不到桌面窗口")?;
    desktop::grab_focus(desktop::handle_of(&window)?);
    Ok(())
}

/// Opens the webview inspector. The interface swallows right-click to keep the
/// browser menu out of the way, which also takes away the usual route in.
#[tauri::command]
fn open_devtools(window: WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window;
}

/// Quits. The desktop surface covers the real desktop, so the stage menu needs a
/// way out that does not require finding the tray icon first — being unable to
/// dismiss what is covering your desktop is the worst failure this app has.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Polled by the desktop surface so it can stop drawing when nobody can see it.
///
/// The same poll puts the window back at the bottom of the z-order, because the
/// two need the same heartbeat and a second timer would only be another thing to
/// keep in step.
#[tauri::command]
fn desktop_occluded(window: WebviewWindow) -> desktop::Occlusion {
    if let Ok(hwnd) = desktop::handle_of(&window) {
        desktop::hold(hwnd);
    }
    desktop::occluded()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    ready: bool,
    onboarded: bool,
    config_path: String,
}

#[tauri::command]
fn status() -> Status {
    let cfg = config::load();
    Status {
        ready: secrets::has_key(),
        onboarded: cfg.onboarded,
        config_path: config::path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Marks the first-run flow as done. Separate from saving a key: the flow can be
/// completed without one.
#[tauri::command]
fn finish_onboarding() -> Result<(), String> {
    let mut cfg = config::load();
    cfg.onboarded = true;
    config::save(&cfg)
}

#[tauri::command]
fn open_config() -> Result<(), String> {
    // load() creates the file with defaults if it is missing, so there is always
    // something to open and paste a key into.
    let _ = config::load();
    let path = config::path().ok_or("找不到配置目录")?;
    opener::open(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// Whether a key is stored, never the key itself — there is no reason for the
    /// secret to travel to the webview just so a placeholder can change.
    has_key: bool,
    model: String,
    base_url: String,
    effect: String,
    autostart: bool,
}

#[tauri::command]
fn read_settings() -> Settings {
    let cfg = config::load();
    Settings {
        has_key: secrets::has_key(),
        model: cfg.model,
        base_url: cfg.base_url,
        effect: cfg.effect,
        autostart: autostart::enabled(),
    }
}

/// Writes config and autostart together. `api_key` empty means "leave the stored
/// key alone" so the settings panel never has to round-trip the secret back just
/// to change the model.
#[tauri::command]
fn write_settings(
    api_key: String,
    model: String,
    base_url: String,
    effect: String,
    autostart_on: bool,
) -> Result<(), String> {
    if !api_key.trim().is_empty() {
        secrets::set_api_key(api_key.trim())?;
    }
    let mut cfg = config::load();
    if !model.trim().is_empty() {
        cfg.model = model.trim().to_string();
    }
    if !base_url.trim().is_empty() {
        cfg.base_url = base_url.trim().to_string();
    }
    if matches!(effect.as_str(), "fog" | "highlight" | "none") {
        cfg.effect = effect;
    }
    config::save(&cfg)?;
    autostart::set(autostart_on)
}

#[tauri::command]
fn read_zones() -> zones::Zones {
    zones::load()
}

#[tauri::command]
fn write_zones(mut value: zones::Zones) -> Result<(), String> {
    // The webview edits zones and pins and knows nothing about `added`, so it
    // sends the field back missing every time. Taking it from disk instead of
    // from the round trip is what stops the first zone edit after a drop from
    // erasing the dropped target.
    value.added = zones::load().added;
    zones::save(&value)
}

/// Runs a tidy. With no zones yet this asks the model to propose the zone set
/// (the first-run suggestion of ADR 0009); afterwards it may only place targets
/// into zones that already exist.
#[tauri::command]
async fn run_tidy() -> Result<zones::Zones, String> {
    let cfg = config::load();
    let key = secrets::api_key();
    if key.trim().is_empty() {
        return Err("还没有填 API key".into());
    }

    // The merged list, not a bare scan: a target the user dropped in is a target
    // like any other, and leaving it out would mean a tidy quietly refuses to
    // file the things they added by hand.
    let found = list_targets();
    let names: Vec<String> = found.iter().map(|t| t.name.clone()).collect();
    let name_to_path: HashMap<String, String> = found
        .iter()
        .map(|t| (t.name.clone(), t.path.clone()))
        .collect();

    let existing = zones::load();

    if existing.zones.is_empty() {
        let proposed = tidy::suggest(&cfg, &key, &names).await?;
        let built = zones::Zones {
            zones: proposed
                .into_iter()
                .map(|(name, members)| zones::Zone {
                    name,
                    items: members
                        .iter()
                        .filter_map(|n| name_to_path.get(n).cloned())
                        .collect(),
                })
                .collect(),
            // Nothing is pinned on a first run, but carrying it through means a
            // rebuilt zone set never silently drops the user's marks.
            pinned: existing.pinned.clone(),
            added: existing.added.clone(),
        };
        zones::save(&built)?;
        return Ok(built);
    }

    let zone_names: Vec<String> = existing.zones.iter().map(|z| z.name.clone()).collect();
    let decision = tidy::assign(&cfg, &key, &names, &zone_names).await?;
    let applied = zones::apply(&existing, &decision, &name_to_path);
    zones::save(&applied)?;
    Ok(applied)
}

pub fn run() {
    tauri::Builder::default()
        .manage(icons::IconCache::default())
        .manage(theme::ThemeCache::default())
        .invoke_handler(tauri::generate_handler![
            list_targets,
            add_targets,
            remove_target,
            launch,
            reveal,
            icons,
            read_theme,
            grab_focus,
            open_devtools,
            quit,
            desktop_occluded,
            status,
            open_config,
            read_settings,
            write_settings,
            finish_onboarding,
            read_zones,
            write_zones,
            run_tidy
        ])
        .setup(|app| {
            // Move a key left behind by an older build into the credential store
            // before anything reads it, so upgrading never asks for it again.
            let mut cfg = config::load();
            if secrets::migrate(&mut cfg) {
                let _ = config::save(&cfg);
            }

            // The tray is now only an escape hatch. The stage's own menu carries
            // everything else, and there is no launchpad left to summon.
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("deskmind")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            // Settle *after* showing. Tauri writes the extended style itself while
            // acting on decorations/skipTaskbar/shadow, so styling first left the
            // window plain and activating by the time it appeared. The occlusion
            // poll re-asserts it from here on.
            if let Some(surface) = app.get_webview_window(DESKTOP) {
                let _ = surface.show();
                if let Err(err) = desktop::handle_of(&surface).and_then(desktop::settle) {
                    // Shown anyway, just as an ordinary window: this surface
                    // carries first-run, so hiding it on failure would leave a
                    // new user with nothing at all.
                    eprintln!("放到桌面位置失败，作为普通窗口显示：{err}");
                }
            }

            Ok(())
        })
        .on_window_event(|_window, event| {
            // There is nowhere to dismiss to. Hiding the only surface would take
            // the desktop away; quitting is what the tray and the stage menu are
            // for, so a close request is simply refused.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("deskmind 启动失败");
}
