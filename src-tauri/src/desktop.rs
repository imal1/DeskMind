//! Living on the desktop. See ADR 0015.
//!
//! deskmind is an ordinary top-level window pinned to the bottom of the z-order,
//! not a child of Progman. Reparenting was tried first and reaches the screen
//! fine, but a WebView2 under Progman never receives a single mouse message —
//! the interface renders and then ignores every click. The spike that blessed
//! `SetParent` used Notepad, a plain Win32 window; WebView2 routes input through
//! its own out-of-process widget and does not survive the move.
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
    fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
    fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
    fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn SetFocus(hwnd: Hwnd) -> Hwnd;
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

const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;
const SWP_FRAMECHANGED: u32 = 0x0020;
/// Last in the z-order, which is where a desktop belongs.
const HWND_BOTTOM: Hwnd = 1;
const GWL_EXSTYLE: i32 = -20;
/// Keeps a click from raising us over the windows the user is actually using.
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
/// Keeps us out of Alt+Tab. A desktop is not something you tab to.
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const SW_SHOWNOACTIVATE: i32 = 4;

fn class_of(hwnd: Hwnd) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// Applies the two styles that make a window behave like a desktop.
///
/// `WS_EX_NOACTIVATE` is the important one: it keeps a click on a tile from
/// raising the whole surface over the windows the user is working in — a real
/// desktop never comes to the front. Mouse messages still arrive; only
/// activation is refused, which is why the keyboard has to be asked for
/// separately (see `grab_focus`). `WS_EX_TOOLWINDOW` takes us out of Alt+Tab.
///
/// Returns whether anything changed, so the caller can skip the repositioning
/// that only matters when it did.
///
/// Applied repeatedly rather than once at startup. Tauri writes the extended
/// style itself when it acts on `decorations`, `skipTaskbar` and `shadow`, and
/// doing that after we had set ours put the window back to plain and activating —
/// which is exactly the state this is meant to prevent. Re-asserting costs one
/// call per second and cannot be undone by whatever Tauri does next.
fn apply_styles(hwnd: Hwnd) -> bool {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        if ex == want {
            return false;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        true
    }
}

/// Turns the window into the desktop: styled, bottom of the z-order, sized to
/// the primary screen.
pub fn settle(hwnd: Hwnd) -> Result<(), String> {
    apply_styles(hwnd);
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW) == 0 {
            return Err("无法把窗口放到桌面位置".into());
        }
    }
    Ok(())
}

/// Puts the surface back where a desktop belongs, for the cases Windows moves it.
///
/// Two of them exist. Win+D and "show desktop" minimise every top-level window,
/// and being a top-level window we are included — a reparented child never was,
/// and this is the one thing that arrangement did better. And an application
/// that calls `SetWindowPos(HWND_TOPMOST)` while starting can end up underneath
/// us, because we are at the bottom only until something else claims it.
///
/// Cheap enough to run on the occlusion poll: two calls, and the reposition is
/// skipped entirely unless the window actually moved.
pub fn hold(hwnd: Hwnd) {
    // Tauri can write the extended style back at any point, so this is checked
    // every tick rather than trusted from startup.
    let restyled = apply_styles(hwnd);
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // A style change only takes effect on the next frame change, so a window
        // that just regained WS_EX_NOACTIVATE has to be told to redraw its frame.
        if restyled {
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
            );
        }
        // Not while we hold the foreground. `grab_focus` puts us there on purpose
        // when the search box needs the keyboard, and sinking mid-typing would
        // drop the surface behind whatever the user last had open.
        if GetForegroundWindow() == hwnd {
            return;
        }
        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );
    }
}

/// Hands keyboard focus to the desktop surface.
///
/// `WS_EX_NOACTIVATE` means clicking us never gives us the keyboard, which is
/// what we want for tiles and wrong for the search box. Joining the foreground
/// thread's input queue lets `SetFocus` reach across; Windows restricts
/// `SetForegroundWindow` but lifts that for a process that just received input,
/// and this only runs in response to a click on our own window.
pub fn grab_focus(hwnd: Hwnd) {
    unsafe {
        let mut pid = 0u32;
        let foreground = GetWindowThreadProcessId(GetForegroundWindow(), &mut pid);
        let mine = GetCurrentThreadId();

        let joined = AttachThreadInput(mine, foreground, 1) != 0;
        SetForegroundWindow(hwnd);
        SetFocus(hwnd);
        if joined {
            AttachThreadInput(mine, foreground, 0);
        }
    }
}

/// Whether the desktop surface is completely hidden behind another window.
///
/// Windows has no cheap "am I occluded" call, and the browser will not help: the
/// surface is never minimised while it is being the desktop, so
/// `document.visibilityState` stays `visible` and `requestAnimationFrame` keeps
/// firing at full rate behind a maximised app. S4 measured exactly that. Without this check a background
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
    fn the_work_area_is_a_real_rectangle() {
        // occluded() compares against this, and a zero rect would make every
        // window look like it covers the desktop.
        let area = work_area();
        assert!(area.right > area.left && area.bottom > area.top);
    }
}
