//! Reading the current wallpaper and deriving the interface colours from it.
//!
//! ADR 0012 says colour follows the wallpaper rather than the system light/dark
//! setting. Note the nuance for this surface: the launchpad draws its own dark
//! veil over the wallpaper, so text legibility comes from the veil, not from the
//! image. Brightness therefore drives **veil strength** here, not text colour.
//! The ADR's text-colour rule applies to the v2 desktop zones, which sit directly
//! on the wallpaper with nothing between.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// Absolute path to the wallpaper file. The frontend loads it through the
    /// asset protocol, so it renders at full resolution with no re-encoding —
    /// an earlier version shipped a downscaled JPEG as a data URL and looked
    /// blurry on a high-DPI display.
    pub path: Option<String>,
    /// Most characteristic non-grey colour in the image, as `#rrggbb`.
    pub accent: String,
    /// 0.0 (black) to 1.0 (white). Drives how strong the veil needs to be.
    pub brightness: f32,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            path: None,
            accent: "#3d4a6b".into(),
            brightness: 0.2,
        }
    }
}

/// Decoding a 4K wallpaper costs real time, so the result is kept and only
/// recomputed when the file path or its modified time changes — which covers
/// both picking a different image and Windows rewriting TranscodedWallpaper.
#[derive(Default)]
pub struct ThemeCache(Mutex<Option<(String, Theme)>>);

fn wallpaper_path() -> Option<PathBuf> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Control Panel\Desktop")
        .ok()?;
    let value: String = key.get_value("WallPaper").ok()?;
    if value.trim().is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.exists().then_some(path)
}

fn stamp(path: &PathBuf) -> String {
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}|{modified}", path.to_string_lossy())
}

fn luminance(r: u8, g: u8, b: u8) -> f32 {
    (0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32) / 255.0
}

/// Picks the colour that best characterises the image: quantise to 4 bits per
/// channel, throw away the greys and the extremes, and take the most populous
/// bucket. Averaging instead would return mud for anything but a monochrome
/// image.
fn accent_of(img: &image::RgbImage) -> String {
    let mut buckets = [0u32; 4096];
    for pixel in img.pixels() {
        let [r, g, b] = pixel.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        if max - min < 28 {
            continue; // too grey to say anything
        }
        let lum = luminance(r, g, b);
        if lum < 0.12 || lum > 0.88 {
            continue; // too dark or too washed out to tint with
        }
        let idx = ((r as usize >> 4) << 8) | ((g as usize >> 4) << 4) | (b as usize >> 4);
        buckets[idx] += 1;
    }

    let Some(idx) = buckets
        .iter()
        .enumerate()
        .filter(|(_, n)| **n > 0)
        .max_by_key(|(_, n)| **n)
        .map(|(i, _)| i)
    else {
        return Theme::default().accent;
    };

    // Back to the middle of the bucket.
    let r = (((idx >> 8) & 0xF) as u8) << 4 | 0x8;
    let g = (((idx >> 4) & 0xF) as u8) << 4 | 0x8;
    let b = ((idx & 0xF) as u8) << 4 | 0x8;
    let (r, g, b) = brighten(r, g, b);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Forces the accent into a usable lightness band, keeping its hue.
///
/// The colour a photograph votes for is often dark — a bamboo forest gives a
/// deep olive. The interface uses the accent as a *fill* under near-black text
/// (active tabs, the primary buttons), so a dark accent turns those into
/// unreadable smudges. The design fixes lightness at oklch 0.79 for exactly this
/// reason; taking the hue from the wallpaper and the lightness from the design is
/// what keeps both promises.
fn brighten(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;

    const TARGET: f32 = 0.72;
    if l >= TARGET - 0.06 {
        return (
            (r * 255.0) as u8,
            (g * 255.0) as u8,
            (b * 255.0) as u8,
        );
    }

    // Scaling channels toward white preserves hue while lifting lightness; a
    // straight multiply would blow out the brightest channel and shift the hue.
    let lift = (TARGET - l) / (1.0 - l).max(0.001);
    let mix = |c: f32| ((c + (1.0 - c) * lift).clamp(0.0, 1.0) * 255.0) as u8;
    (mix(r), mix(g), mix(b))
}

fn build(path: &PathBuf) -> Theme {
    let Ok(decoded) = image::open(path) else {
        return Theme::default();
    };

    // One small copy answers both colour questions. The image is never re-encoded
    // for display — the frontend reads the original file directly.
    let small = decoded
        .resize(64, 64, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let accent = accent_of(&small);
    let total: f32 = small
        .pixels()
        .map(|p| luminance(p.0[0], p.0[1], p.0[2]))
        .sum();
    let brightness = total / (small.width() * small.height()) as f32;

    Theme {
        path: Some(path.to_string_lossy().into_owned()),
        accent,
        brightness,
    }
}

pub fn current(cache: &ThemeCache) -> Theme {
    let Some(path) = wallpaper_path() else {
        return Theme::default();
    };
    let key = stamp(&path);

    if let Some((cached_key, theme)) = cache.0.lock().expect("theme cache poisoned").as_ref() {
        if *cached_key == key {
            return theme.clone();
        }
    }

    let theme = build(&path);
    *cache.0.lock().expect("theme cache poisoned") = Some((key, theme.clone()));
    theme
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(r: u8, g: u8, b: u8) -> image::RgbImage {
        image::RgbImage::from_pixel(8, 8, image::Rgb([r, g, b]))
    }

    #[test]
    fn grey_images_fall_back_to_the_default_accent() {
        assert_eq!(accent_of(&flat(128, 128, 128)), Theme::default().accent);
    }

    #[test]
    fn a_saturated_image_yields_a_colour_in_the_same_family() {
        let hex = accent_of(&flat(30, 90, 200));
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let b = u8::from_str_radix(&hex[5..7], 16).unwrap();
        assert!(b > r, "expected a blue-dominant accent, got {hex}");
    }

    #[test]
    fn a_dark_wallpaper_still_yields_a_light_accent() {
        // A deep forest green: the colour the image votes for, but far too dark
        // to sit under near-black button text.
        let hex = accent_of(&flat(28, 62, 24));
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap() as f32;
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap() as f32;
        let b = u8::from_str_radix(&hex[5..7], 16).unwrap() as f32;
        let l = (r.max(g).max(b) + r.min(g).min(b)) / 2.0 / 255.0;
        assert!(l > 0.6, "accent too dark for black text: {hex} (l={l:.2})");
        assert!(g > r && g > b, "hue should survive the lift, got {hex}");
    }

    #[test]
    fn brightness_spans_the_range() {
        let dark: f32 = flat(10, 10, 10)
            .pixels()
            .map(|p| luminance(p.0[0], p.0[1], p.0[2]))
            .sum::<f32>()
            / 64.0;
        let light: f32 = flat(245, 245, 245)
            .pixels()
            .map(|p| luminance(p.0[0], p.0[1], p.0[2]))
            .sum::<f32>()
            / 64.0;
        assert!(dark < 0.1 && light > 0.9);
    }
}
