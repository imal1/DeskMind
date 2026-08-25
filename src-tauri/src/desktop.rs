//! Living on the desktop layer. See ADR 0015 and `spikes/s3-workerw/FINDINGS.md`.
//!
//! The Win32 entry points are declared here by hand rather than pulled from the
//! `windows` crate: `HWND` has changed between `isize` and `*mut c_void` across
//! that crate's versions, and Tauri pins its own version independently. Passing
//! handles around as `isize` keeps this module immune to that.

use std::ffi::c_void;

type Hwnd = isize;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, window: *const u16) -> Hwnd;
    fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, window: *const u16) -> Hwnd;
    fn SendMessageTimeoutW(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
        flags: u32,
        timeout: u32,
        result: *mut usize,
    ) -> isize;
    fn EnumWindows(callback: extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
    fn SetParent(child: Hwnd, parent: Hwnd) -> Hwnd;
    fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn IsWindowVisible(hwnd: Hwnd) -> i32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn SetFocus(hwnd: Hwnd) -> Hwnd;
    fn GetParent(hwnd: Hwnd) -> Hwnd;
    fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    fn AttachThreadInput(attach: u32, attach_to: u32, join: i32) -> i32;
    fn IsIconic(hwnd: Hwnd) -> i32;
    fn SystemParametersInfoW(action: u32, uparam: u32, data: *mut c_void, winini: u32) -> i32;
}

const SPI_GETWORKAREA: u32 = 0x0030;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
}

/// Undocumented. Makes the shell create the WorkerW that backs the desktop.
const SPAWN_WORKERW: u32 = 0x052C;
const SMTO_NORMAL: u32 = 0x0000;
const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn class_of(hwnd: Hwnd) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

fn has_icon_layer(hwnd: Hwnd) -> bool {
    let class = wide("SHELLDLL_DefView");
    unsafe { FindWindowExW(hwnd, 0, class.as_ptr(), std::ptr::null()) != 0 }
}

extern "system" fn collect(hwnd: Hwnd, lparam: isize) -> i32 {
    // Safety: `lparam` is the &mut Vec we passed to EnumWindows, which outlives
    // the call because EnumWindows is synchronous.
    let out = unsafe { &mut *(lparam as *mut Vec<Hwnd>) };
    out.push(hwnd);
    1
}

fn top_level_windows() -> Vec<Hwnd> {
    let mut found: Vec<Hwnd> = Vec::with_capacity(256);
    unsafe {
        EnumWindows(collect, &mut found as *mut Vec<Hwnd> as isize);
    }
    found
}

fn progman() -> Option<Hwnd> {
    let class = wide("Progman");
    let hwnd = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    (hwnd != 0).then_some(hwnd)
}

/// Asks the shell for the desktop-backing WorkerW and returns the window to
/// parent into.
///
/// Two shell layouts exist. On the machine S3 was run on, the icon layer lives
/// under Progman and every WorkerW is empty, which breaks the widely-quoted
/// "take the WorkerW sibling after the one holding SHELLDLL_DefView" recipe. So
/// the choice is made on observable properties instead: a full-screen, visible
/// WorkerW that hosts no icon layer of its own.
fn desktop_parent() -> Option<Hwnd> {
    let progman = progman()?;

    let mut ignored: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            progman,
            SPAWN_WORKERW,
            0,
            0,
            SMTO_NORMAL,
            1000,
            &mut ignored,
        );
    }

    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let candidates: Vec<Hwnd> = top_level_windows()
        .into_iter()
        .filter(|h| class_of(*h) == "WorkerW" && !has_icon_layer(*h))
        .collect();

    let full_screen = |h: &Hwnd| {
        let mut rect = Rect::default();
        unsafe { GetWindowRect(*h, &mut rect) };
        rect.right - rect.left >= screen_w
    };

    candidates
        .iter()
        .find(|h| full_screen(h) && unsafe { IsWindowVisible(**h) } != 0)
        .or_else(|| candidates.iter().find(|h| full_screen(h)))
        .copied()
        // Progman itself is still the desktop layer — just above the icons rather
        // than below them, which is fine because we draw our own tiles.
        .or(Some(progman))
}

/// Parents `child` into the desktop layer and sizes it to the primary screen.
pub fn dock(child: Hwnd) -> Result<(), String> {
    let parent = desktop_parent().ok_or("找不到桌面层窗口")?;
    unsafe {
        SetParent(child, parent);
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        SetWindowPos(
            child,
            0,
            0,
            0,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
    Ok(())
}

/// Hands keyboard focus to a docked window.
///
/// Keyboard messages only reach the focus window of the *active top-level*
/// window, and after docking that is the desktop, not us. Joining the input
/// queues lets `SetFocus` reach across, which is the manoeuvre S3 verified.
///
/// Windows restricts `SetForegroundWindow`, but lifts the restriction for the
/// process that just received input — and this only ever runs in response to a
/// click on our own window, so we qualify.
pub fn grab_focus(child: Hwnd) {
    unsafe {
        let mut top = child;
        loop {
            let parent = GetParent(top);
            if parent == 0 {
                break;
            }
            top = parent;
        }

        let mut pid = 0u32;
        let foreground = GetWindowThreadProcessId(GetForegroundWindow(), &mut pid);
        let mine = GetCurrentThreadId();

        let joined = AttachThreadInput(mine, foreground, 1) != 0;
        SetForegroundWindow(top);
        SetFocus(child);
        if joined {
            AttachThreadInput(mine, foreground, 0);
        }
    }
}

/// Whether the desktop surface is completely hidden behind another window.
///
/// Windows has no cheap "am I occluded" call, and the browser will not help: a
/// docked window is never minimised, so `document.visibilityState` stays
/// `visible` and `requestAnimationFrame` keeps firing at full rate behind a
/// maximised app. S4 measured exactly that. Without this check a background
/// shader would burn the GPU with nobody watching, which ADR 0016 rules out.
///
/// The heuristic looks only at the foreground window rather than enumerating
/// everything: it costs three calls, and the case that matters — a maximised
/// application on top — is precisely the foreground one. A partially covering
/// window keeps us rendering, which is the right answer since part of the
/// surface is still visible.
/// Reports the decision and the numbers behind it, so a wrong answer can be read
/// rather than guessed at.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Occlusion {
    pub occluded: bool,
    pub front_class: String,
    pub front_rect: [i32; 4],
    pub work_area: [i32; 4],
    pub why: String,
}

fn work_area() -> Rect {
    let mut rect = Rect::default();
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut rect as *mut Rect as *mut c_void,
            0,
        )
    };
    if ok == 0 {
        // Falling back to the full screen makes the test stricter, never looser.
        rect = Rect {
            left: 0,
            top: 0,
            right: unsafe { GetSystemMetrics(SM_CXSCREEN) },
            bottom: unsafe { GetSystemMetrics(SM_CYSCREEN) },
        };
    }
    rect
}

pub fn occluded() -> Occlusion {
    let area = work_area();
    let mut out = Occlusion {
        occluded: false,
        front_class: String::new(),
        front_rect: [0; 4],
        work_area: [area.left, area.top, area.right, area.bottom],
        why: String::new(),
    };

    unsafe {
        let front = GetForegroundWindow();
        if front == 0 {
            out.why = "没有前台窗口".into();
            return out;
        }
        if IsIconic(front) != 0 {
            out.why = "前台窗口已最小化".into();
            return out;
        }

        out.front_class = class_of(front);
        // Shell windows in front mean the user is looking at the desktop, which
        // is us.
        if matches!(
            out.front_class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd"
        ) {
            out.why = "前台是 shell，用户在看桌面".into();
            return out;
        }

        let mut rect = Rect::default();
        if GetWindowRect(front, &mut rect) == 0 {
            out.why = "取不到前台窗口矩形".into();
            return out;
        }
        out.front_rect = [rect.left, rect.top, rect.right, rect.bottom];

        // Against the work area, not the screen: a maximised window stops at the
        // taskbar, so requiring full-screen coverage never matched. A few pixels
        // of slack absorbs the invisible resize border Windows leaves on
        // maximised windows, and DPI rounding.
        const SLACK: i32 = 8;
        out.occluded = rect.left <= area.left + SLACK
            && rect.top <= area.top + SLACK
            && rect.right >= area.right - SLACK
            && rect.bottom >= area.bottom - SLACK;
        out.why = if out.occluded {
            "前台窗口盖满工作区".into()
        } else {
            "前台窗口没盖满".into()
        };
    }
    out
}

/// Converts whatever Tauri hands back for a window handle into our `isize`.
pub fn handle_of(window: &tauri::WebviewWindow) -> Result<Hwnd, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    Ok(hwnd.0 as *mut c_void as isize)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn progman_exists_and_is_named_correctly() {
        let hwnd = progman().expect("Progman should exist while explorer runs");
        assert_eq!(class_of(hwnd), "Progman");
    }

    #[test]
    fn a_desktop_parent_is_always_found() {
        // Worst case this falls back to Progman, so it must never be None.
        assert!(desktop_parent().is_some());
    }
}
