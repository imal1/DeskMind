//! Asking the shell for a file's real icon.
//!
//! `systemicons` only reads the actual file for paths ending in `.exe`; anything
//! else goes through `SHGetFileInfoW` with `SHGFI_USEFILEATTRIBUTES`, which looks
//! the icon up **by extension without opening the file**. Handed a `.lnk` that
//! returns the generic shortcut glyph — identical for every program, wearing the
//! overlay arrow.
//!
//! Dropping that one flag makes the shell resolve the shortcut properly, and it
//! covers the Store and MSI-advertised entries that the `lnk` crate cannot follow
//! because they have no filesystem target at all.
//!
//! Entry points are declared by hand for the same reason as in `desktop`: no
//! dependency on which `windows` crate version anything else happens to pin.

use std::ffi::c_void;

type Handle = isize;

#[repr(C)]
struct ShFileInfoW {
    h_icon: Handle,
    i_icon: i32,
    dw_attributes: u32,
    sz_display_name: [u16; 260],
    sz_type_name: [u16; 80],
}

#[repr(C)]
#[derive(Default)]
struct IconInfo {
    f_icon: i32,
    x_hotspot: u32,
    y_hotspot: u32,
    hbm_mask: Handle,
    hbm_color: Handle,
}

#[repr(C)]
#[derive(Default)]
struct Bitmap {
    bm_type: i32,
    bm_width: i32,
    bm_height: i32,
    bm_width_bytes: i32,
    bm_planes: u16,
    bm_bits_pixel: u16,
    bm_bits: usize,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct BitmapInfoHeader {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetFileInfoW(
        path: *const u16,
        file_attributes: u32,
        info: *mut ShFileInfoW,
        info_size: u32,
        flags: u32,
    ) -> usize;

    /// Extracts an icon at a **requested** size, unlike `SHGetFileInfoW` which
    /// only ever hands back the system's small or large metric. `nIconSize`
    /// packs the large size in the low word and the small one in the high word.
    fn SHDefExtractIconW(
        icon_file: *const u16,
        index: i32,
        flags: u32,
        large: *mut Handle,
        small: *mut Handle,
        icon_size: u32,
    ) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn GetIconInfo(icon: Handle, info: *mut IconInfo) -> i32;
    fn DestroyIcon(icon: Handle) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetObjectW(handle: Handle, size: i32, out: *mut c_void) -> i32;
    fn GetDIBits(
        hdc: Handle,
        bitmap: Handle,
        start: u32,
        lines: u32,
        bits: *mut c_void,
        info: *mut BitmapInfoHeader,
        usage: u32,
    ) -> i32;
    fn DeleteObject(handle: Handle) -> i32;
    fn CreateCompatibleDC(hdc: Handle) -> Handle;
    fn DeleteDC(hdc: Handle) -> i32;
}

/// Modern executables carry icons up to 256px. Asking for that and letting the
/// browser scale down keeps tiles and the detail panel sharp; asking for the
/// system's 32px "large" icon and scaling *up* to 68px is why they looked soft.
const WANT_SIZE: u32 = 256;

const SHGFI_ICON: u32 = 0x0000_0100;
const SHGFI_LARGEICON: u32 = 0x0000_0000;
const DIB_RGB_COLORS: u32 = 0;
const BI_RGB: u32 = 0;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Frees the GDI objects an ICONINFO hands out. They are copies; leaking them
/// leaks kernel handles, and we run this once per launch target.
struct IconInfoGuard(IconInfo);

impl Drop for IconInfoGuard {
    fn drop(&mut self) {
        unsafe {
            if self.0.hbm_color != 0 {
                DeleteObject(self.0.hbm_color);
            }
            if self.0.hbm_mask != 0 {
                DeleteObject(self.0.hbm_mask);
            }
        }
    }
}

struct IconGuard(Handle);

impl Drop for IconGuard {
    fn drop(&mut self) {
        unsafe {
            if self.0 != 0 {
                DestroyIcon(self.0);
            }
        }
    }
}

/// Asks for a large icon from a file that contains one. Returns 0 when the file
/// has no icon resource at that size.
fn extract_large(path: &str) -> Handle {
    let wide_path = wide(path);
    let mut large: Handle = 0;
    let ok = unsafe {
        SHDefExtractIconW(
            wide_path.as_ptr(),
            0,
            0,
            &mut large,
            std::ptr::null_mut(),
            WANT_SIZE,
        )
    };
    if ok == 0 {
        large
    } else {
        0
    }
}

/// Returns the file's icon as PNG bytes, or `None` when nothing can be read.
pub fn png_of(path: &str) -> Option<Vec<u8>> {
    // Shortcuts have no icon resource of their own, so resolve first and ask the
    // program itself for its highest-resolution artwork.
    let resolved = crate::shortcut::is_shortcut(path)
        .then(|| crate::shortcut::resolve(path))
        .flatten();
    let mut handle = extract_large(resolved.as_deref().unwrap_or(path));

    // Falling back to the shell's own lookup: it resolves anything — Store
    // entries, MSI shortcuts — but only at the system's large-icon metric.
    if handle == 0 {
        let wide_path = wide(path);
        // Zeroed rather than Default: the struct carries two large arrays.
        let mut info: ShFileInfoW = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            SHGetFileInfoW(
                wide_path.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<ShFileInfoW>() as u32,
                // No SHGFI_USEFILEATTRIBUTES: that is the whole point. And no
                // SHGFI_LINKOVERLAY, so shortcuts come back without the arrow.
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if ok == 0 {
            return None;
        }
        handle = info.h_icon;
    }
    if handle == 0 {
        return None;
    }
    let icon = IconGuard(handle);

    let mut raw = IconInfo::default();
    if unsafe { GetIconInfo(icon.0, &mut raw) } == 0 {
        return None;
    }
    let icon_info = IconInfoGuard(raw);
    if icon_info.0.hbm_color == 0 {
        // Monochrome icon: the image lives in the mask, split top and bottom.
        // Rare enough that falling back is cheaper than handling it.
        return None;
    }

    let mut bitmap = Bitmap::default();
    let read = unsafe {
        GetObjectW(
            icon_info.0.hbm_color,
            std::mem::size_of::<Bitmap>() as i32,
            &mut bitmap as *mut Bitmap as *mut c_void,
        )
    };
    if read == 0 || bitmap.bm_width <= 0 || bitmap.bm_height <= 0 {
        return None;
    }

    let width = bitmap.bm_width;
    let height = bitmap.bm_height;

    let mut header = BitmapInfoHeader {
        bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
        bi_width: width,
        // Negative height asks for a top-down buffer, saving a row flip.
        bi_height: -height,
        bi_planes: 1,
        bi_bit_count: 32,
        bi_compression: BI_RGB,
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = unsafe { CreateCompatibleDC(0) };
    if hdc == 0 {
        return None;
    }
    let copied = unsafe {
        GetDIBits(
            hdc,
            icon_info.0.hbm_color,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut c_void,
            &mut header,
            DIB_RGB_COLORS,
        )
    };
    unsafe { DeleteDC(hdc) };
    if copied == 0 {
        return None;
    }

    // GDI hands back BGRA.
    let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
        // Some icons report 32bpp yet leave alpha zeroed. Reading that literally
        // renders them fully transparent, which looks like a missing icon.
        if opaque {
            chunk[3] = 255;
        }
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    let mut png = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )
        .ok()?;
    Some(png)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn a_real_executable_yields_a_png() {
        let png = png_of(r"C:\Windows\notepad.exe").expect("notepad should have an icon");
        assert_eq!(&png[1..4], b"PNG", "expected PNG magic bytes");
    }

    #[test]
    fn a_missing_path_yields_none_rather_than_a_placeholder() {
        // Without SHGFI_USEFILEATTRIBUTES the shell has to open the file, so a
        // path that does not exist gives nothing — which is what lets the caller
        // decide on a fallback instead of silently getting a generic glyph.
        assert!(png_of(r"C:\definitely\not\here.lnk").is_none());
    }
}
