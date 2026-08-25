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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LAUNCHPAD: &str = "launchpad";
const DESKTOP: &str = "desktop";

/// Alt+Space, not Ctrl+Space: on Chinese Windows the latter is the IME's
/// English/Chinese toggle, so it never reaches us. Alt+Space nominally opens the
/// window system menu, but a registered global shortcut takes precedence — this
/// is the same key PowerToys Run uses.
const HOTKEY_MODS: Modifiers = Modifiers::ALT;
const HOTKEY_CODE: Code = Code::Space;

#[tauri::command]
fn list_targets() -> Vec<targets::LaunchTarget> {
    targets::scan()
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

/// Called by the desktop window on every mouse-down. Docking costs us the normal
/// activation path, so keyboard focus has to be taken deliberately each time the
/// user touches the surface (ADR 0015).
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

/// Polled by the desktop surface so it can stop drawing when nobody can see it.
#[tauri::command]
fn desktop_occluded() -> desktop::Occlusion {
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
fn write_zones(value: zones::Zones) -> Result<(), String> {
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

    let found = targets::scan();
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

fn launchpad(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LAUNCHPAD)
}

fn show(app: &AppHandle) {
    if let Some(w) = launchpad(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The launchpad is summoned and dismissed, never opened and closed. Every
/// entry point (hotkey, tray click, Esc) funnels through show/hide so the
/// window's lifetime is independent of the process's.
fn toggle(app: &AppHandle) {
    let Some(w) = launchpad(app) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(icons::IconCache::default())
        .manage(theme::ThemeCache::default())
        .invoke_handler(tauri::generate_handler![
            list_targets,
            launch,
            reveal,
            icons,
            read_theme,
            grab_focus,
            open_devtools,
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

            let open = MenuItem::with_id(app, "open", "打开启动台", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("deskmind")
                .menu(&menu)
                // Left click toggles; the menu belongs to right click only.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;

            // Dock the desktop surface before showing it: parenting first means
            // it never appears as a normal window, not even for a frame.
            if let Some(surface) = app.get_webview_window(DESKTOP) {
                if let Err(err) = desktop::handle_of(&surface).and_then(desktop::dock) {
                    // Shown anyway, just as an ordinary window: it is the surface
                    // that carries first-run, so hiding it on failure would leave
                    // a new user with nothing at all.
                    eprintln!("挂到桌面层失败，作为普通窗口显示：{err}");
                }
                let _ = surface.show();
            }

            let hotkey = Shortcut::new(Some(HOTKEY_MODS), HOTKEY_CODE);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && shortcut.matches(HOTKEY_MODS, HOTKEY_CODE)
                        {
                            toggle(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(hotkey)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window would end the process. The tray owns the
            // process lifetime, so a close request means "dismiss".
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("deskmind 启动失败");
}
