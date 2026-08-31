/**
 * The scene layer — effects D and B of ADR 0016.
 *
 * One fullscreen shader composes everything behind the interface: the wallpaper,
 * thin bands of light drifting across it, and refractive glass for the panels
 * floating above.
 *
 * There used to be three treatments to choose between — bands, fog, and none at
 * all. There is one now, the one modelled on the iOS/tvOS 27 chrome: clear rather
 * than frosted, with the lift on the panels instead of a dimming of everything
 * behind them.
 *
 * The glass refracts the **live interface**, captured through HTML-in-Canvas: the
 * tiles, text and rail under a panel bend with it. An earlier version composed
 * the backdrop procedurally instead, which was cheaper and needed no flag, but it
 * could only ever distort the wallpaper — and glass over a photograph reads as a
 * filter, not as glass. Distorting the content is what sells it.
 *
 * When the capture is unavailable — the API is behind a flag and still an origin
 * trial — the procedural path is still there and takes over silently.
 *
 * Raw WebGL2, no library (see ADR 0016). Rendering stops entirely when the
 * surface is covered — S4 measured requestAnimationFrame running at full rate
 * behind a maximised window.
 */

import { invoke } from "@tauri-apps/api/core";
import { createCapture, type Capture } from "./capture";

/**
 * The verdict and the reasoning behind it. Rust works all of this out; taking
 * only the boolean threw away the half that says *why*, which is the half needed
 * when the answer is wrong — and the answer can only be wrong while the desktop
 * is covered, which is exactly when nobody can look at the screen to find out.
 */
type Occlusion = {
  occluded: boolean;
  /** Plain-language reason, set only when the verdict is "not covered". */
  why: string;
  /** Window class of whatever holds the foreground. */
  frontClass: string;
  frontRect: [number, number, number, number];
  workArea: [number, number, number, number];
};

/**
 * The glass's own numbers, lifted out of the shader source so #15's bench can
 * move them while looking at the result — and so a failed acceptance can name a
 * term rather than a feeling.
 *
 * The defaults below are exactly the literals they replaced. Nothing about the
 * shipped look depends on this having been done, and nothing sets them except
 * the bench.
 */
export type Tuning = {
  /** Index of refraction of the slab. 1 is air, ~1.5 is window glass. */
  ior: number;
  /** How deep the slab is, in device pixels. Sets how far the bend carries. */
  thickness: number;
  /** Width of the bevel, in device pixels. */
  rim: number;
  /** Spread between the channels' indices. Real dispersion, not a scaled offset. */
  dispersion: number;
  /** Frost, rim to centre, as mip levels. Pre-filter for the gather below. */
  lod: [number, number];
  /** How far the frost gathers from at the centre, in device pixels. */
  blur: number;
  /** How close two panels have to be before they pull at each other, in pixels. */
  merge: number;
  /** Darkening, rim to centre. */
  dark: [number, number];
  /** Darkening on the fallback path, where only the wallpaper is refracted. */
  darkOff: [number, number];
  /** Accent glow at the rim. */
  glow: number;
  /** White specular at the rim. */
  specular: number;
  /** Specular tightness. Bigger is a thinner band. */
  shine: number;
  /** How much of the surroundings the bevel reflects. */
  env: number;
  /** Per-term switches: on keeps the term, off removes it. */
  on: {
    refract: boolean;
    dispersion: boolean;
    frost: boolean;
    darken: boolean;
    specular: boolean;
    env: boolean;
    glow: boolean;
    border: boolean;
    shadow: boolean;
  };
};

export const DEFAULT_TUNING: Tuning = {
  ior: 1.45,
  thickness: 34,
  rim: 34,
  dispersion: 0.03,
  lod: [1.2, 3.0],
  blur: 22,
  merge: 28,
  dark: [0.16, 0.54],
  darkOff: [0.06, 0.26],
  glow: 0.1,
  specular: 0.34,
  shine: 24,
  env: 0.12,
  on: {
    refract: true,
    dispersion: true,
    frost: true,
    darken: true,
    specular: true,
    env: true,
    glow: true,
    border: true,
    shadow: true,
  },
};

function applyTuning(
  gl: WebGL2RenderingContext,
  u: Record<string, WebGLUniformLocation | null>,
  t: Tuning,
): void {
  const bit = (b: boolean) => (b ? 1 : 0);
  gl.uniform1f(u.tIor!, t.ior);
  gl.uniform1f(u.tThick!, t.thickness);
  gl.uniform1f(u.tRim!, t.rim);
  gl.uniform1f(u.tDisp!, t.dispersion);
  gl.uniform2f(u.tLod!, t.lod[0], t.lod[1]);
  gl.uniform1f(u.tBlur!, t.blur);
  gl.uniform1f(u.tMerge!, t.merge);
  gl.uniform2f(u.tDark!, t.dark[0], t.dark[1]);
  gl.uniform2f(u.tDarkOff!, t.darkOff[0], t.darkOff[1]);
  gl.uniform1f(u.tGlow!, t.glow);
  gl.uniform1f(u.tSpec!, t.specular);
  gl.uniform1f(u.tShine!, t.shine);
  gl.uniform1f(u.tEnv!, t.env);
  gl.uniform4f(u.fxA!, bit(t.on.refract), bit(t.on.dispersion), bit(t.on.frost), bit(t.on.darken));
  gl.uniform4f(u.fxB!, bit(t.on.specular), bit(t.on.glow), bit(t.on.border), bit(t.on.shadow));
  gl.uniform4f(u.fxC!, bit(t.on.env), 0, 0, 0);
}

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

export type GlassRect = Box & {
  /**
   * Identity across calls. `setGlass` is handed the whole list every time, so
   * without this a panel that moved would be indistinguishable from one panel
   * vanishing and another appearing — and nothing could be followed.
   */
  key?: string;
  /**
   * Where it grows out of, and shrinks back into. The button that opened it, or
   * the pointer for a menu. Left out, it grows from its own centre.
   */
  from?: Box;
};

const mixBox = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  width: a.width + (b.width - a.width) * t,
  height: a.height + (b.height - a.height) * t,
  radius: a.radius + (b.radius - a.radius) * t,
});

/** A panel with no stated origin grows out of its own middle, from nothing. */
const pip = (b: Box): Box => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
  width: 0,
  height: 0,
  radius: 0,
});

const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 res;
uniform float time;
uniform vec3 accent;
uniform sampler2D wallpaper;
uniform float hasWallpaper;
uniform float wallAspect;
const int MAX_GLASS = 6;
uniform vec4 glassRect[MAX_GLASS];   // x, y, width, height in pixels, y from the bottom
uniform float glassRadius[MAX_GLASS];
uniform int glassCount;
uniform float glassAmount;
uniform vec3 veil;       // darkening alpha at the bottom, middle and top
uniform float glassOnly; // 1 for the layer that draws nothing but the glass

// The glass's own numbers, promoted out of the source so #15's bench can move
// them while looking at the result. Defaults are the values they replaced, so
// nothing about the shipped look depends on this having been done.
uniform float tIor;      // index of refraction of the slab
uniform float tThick;    // how deep the slab is, in device pixels
uniform float tRim;      // width of the bevel, in device pixels
uniform float tDisp;     // channel spread as a fraction of the offset, was 0.03
uniform vec2 tLod;       // frost, rim to centre, was (1.2, 5.0)
uniform float tBlur;     // how far the frost gathers from, in device pixels
uniform float tMerge;    // how far apart two panels still pull at each other
uniform vec2 tDark;      // darkening, rim to centre, was (0.16, 0.54)
uniform vec2 tDarkOff;   // the same, on the fallback path, was (0.06, 0.26)
uniform float tGlow;     // accent rim glow, was 0.10
uniform float tSpec;     // white rim specular, was 0.34
uniform float tShine;    // specular tightness: bigger is a thinner band
uniform float tEnv;      // how much of the surroundings the bevel reflects
uniform vec3 tLight;     // point light: xy on screen in device pixels, z above it
// Per-term switches, so a failed acceptance can name a term instead of a
// feeling: refract, dispersion, frost, darken.
uniform vec4 fxA;
// specular, accent glow, border, shadow.
uniform vec4 fxB;
// environment reflection, and three spare.
uniform vec4 fxC;
uniform sampler2D ui;    // the live interface, captured through HTML-in-Canvas
uniform float hasUi;     // 0 when the capture is unavailable

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

/// Cover-fit, so a wallpaper of any shape fills an ultrawide without stretching.
vec2 coverUv(vec2 uv) {
  float screen = res.x / res.y;
  // Sample a narrower slice of whichever axis has to be cropped.
  vec2 scale = screen > wallAspect
    ? vec2(1.0, wallAspect / screen)
    : vec2(screen / wallAspect, 1.0);
  return (uv - 0.5) * scale + 0.5;
}

/// Everything behind the interface, sampled at an arbitrary point. The glass
/// calls this with bent coordinates; everywhere else calls it straight.
vec3 scene(vec2 uv, float lod) {
  // Mip level as blur. The wallpaper is our own texture, so a blurred read costs
  // one sample instead of the dozens a gaussian would need — which is what makes
  // it affordable to draw the panel's frosting here rather than in CSS.
  vec3 base = hasWallpaper > 0.5
    ? textureLod(wallpaper, clamp(coverUv(uv), 0.0, 1.0), lod).rgb
    : vec3(0.07, 0.08, 0.11);

  // Aspect-corrected so nothing smears into streaks on a wide screen.
  vec2 p = vec2(uv.x * (res.x / res.y), uv.y);
  vec3 col = base;

  // Crossing bands of light that drift, sharpened so they stay thin and clean.
  // Sheen rather than volume: the wallpaper is left mostly alone and only catches
  // the light.
  float a1 = sin((p.x * 1.2 + p.y * 0.6) * 2.4 + time * 0.25) * 0.5 + 0.5;
  float b1 = sin((p.x * -0.8 + p.y * 1.4) * 1.7 - time * 0.19) * 0.5 + 0.5;
  float s = pow(a1 * b1, 6.0);
  // A slow wander so the bands never sit still enough to look like a texture.
  s *= 0.7 + 0.3 * fbm(p * 0.9 + time * 0.02);
  col = base + mix(vec3(1.0), accent, 0.45) * s * 0.5;

  // The veil belongs in here rather than in a DOM layer above the canvas: it is
  // part of the backdrop, so the glass has to refract it along with everything
  // else. A CSS layer stacked on top would sit over the refraction and hide it.
  //
  // Dark and light-handed, at 0.55 of what the gradient asks for. Brightening the
  // whole wallpaper was glaring, and the lift belongs on the panels and the rail
  // rather than on everything at once.
  float a = uv.y < 0.5
    ? mix(veil.x, veil.y, smoothstep(0.0, 0.5, uv.y))
    : mix(veil.y, veil.z, smoothstep(0.5, 1.0, uv.y));

  return mix(col, vec3(0.024, 0.027, 0.043), a * 0.55);
}

/// What the glass refracts.
///
/// With a capture of the interface we sample that: the panel then bends the real
/// tiles, text and rail underneath it, which is what makes it read as glass
/// rather than as a filter over a photograph. Without one we fall back to
/// composing the backdrop procedurally, which is correct but only ever shows the
/// wallpaper.
vec3 behind(vec2 uv, float lod) {
  if (hasUi > 0.5) return textureLod(ui, clamp(uv, 0.0, 1.0), lod).rgb;
  return scene(uv, lod);
}

float sdRoundBox(vec2 p, vec2 half_size, float r) {
  vec2 q = abs(p) - half_size + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

/// Opaque once we own the wallpaper; translucent while we do not, so the CSS
/// wallpaper underneath still shows and a failed texture upload degrades to
/// a wash over the picture rather than to a black screen.
float sceneAlpha() { return hasWallpaper > 0.5 ? 1.0 : 0.55; }

/// Where a pixel on the glass reads the backdrop from: refract the view ray at
/// the bevel, then follow it down through the slab.
///
/// Dispersion falls out of this rather than being painted on — the three
/// channels are given three different indices, so they leave at three different
/// angles the way they do in glass, instead of being the same offset scaled by
/// three amounts, which only ever produced a doubled edge.
vec2 lens(vec3 N, float ior) {
  vec3 R = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / max(ior, 1.0));
  if (R.z > -1e-4) return vec2(0.0);
  return R.xy * (tThick / -R.z);
}

/// Smooth minimum. Two surfaces closer together than k grow a neck between them
/// and then fuse; further apart than k this is exactly min(), so distant panels
/// do not know about each other. The falloff is the whole behaviour — nothing
/// has to measure the gap and decide, it comes out of the arithmetic.
float smin(float a, float b, float k) {
  if (k <= 0.0001) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/// The whole glass field, as one surface rather than a list of rectangles.
///
/// This replaces picking the nearest rectangle and then working from its centre
/// and half-size. That could never merge: two panels touching would still be
/// two separate bevels meeting at a seam, because everything downstream was
/// derived from whichever single rectangle won. A field has no seam to have.
float fieldAt(vec2 p) {
  float d = 1e9;
  for (int i = 0; i < MAX_GLASS; i++) {
    if (i >= glassCount) break;
    vec2 c = glassRect[i].xy + glassRect[i].zw * 0.5;
    vec2 h = glassRect[i].zw * 0.5;
    d = smin(d, sdRoundBox(p - c, h, glassRadius[i]), tMerge);
  }
  return d;
}

const int TAPS = 8;

/// Gathers the backdrop over a disc rather than taking one mip fetch.
///
/// A single textureLod is a box pyramid, and at the levels the middle of a panel
/// asks for it is sampling a thirty-second of the image: what comes back is
/// blocky, with visible steps where one level gives way to the next. Real frost
/// is a continuous gather, and the material this is imitating is frosted — the
/// blur is the body of it, not a finish applied to it.
///
/// Taps are laid on a golden-angle spiral, which spaces them evenly without the
/// rotational banding a ring produces. The mip level is kept as a pre-filter so
/// each tap is already area-averaged and the taps do not alias against each
/// other.
vec3 gather(vec2 px, float lod, float radius) {
  if (radius < 0.5) return behind(px / res, lod);
  vec3 sum = behind(px / res, lod);
  for (int i = 0; i < TAPS; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / float(TAPS)) * radius;
    sum += behind((px + vec2(cos(a), sin(a)) * r) / res, lod);
  }
  return sum / float(TAPS + 1);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / res;

  // The backdrop layer never draws glass; the glass layer never draws anything
  // else. Two passes, because the glass has to sit above the backdrop — one layer
  // cannot be on both sides of it.
  if (glassAmount < 0.01 || glassOnly < 0.5) {
    if (glassOnly > 0.5) { outColor = vec4(0.0); return; }
    outColor = vec4(scene(uv, 0.0), sceneAlpha());
    return;
  }

  float d = fieldAt(frag);

  if (glassCount == 0) {
    outColor = vec4(0.0);
    return;
  }

  // Well outside: the panel's shadow, drawn here so the CSS box-shadow can go. A
  // shader shadow follows the same rounded rectangle the glass does, so the two
  // can never disagree about where the panel is.
  float shadow = (1.0 - smoothstep(0.0, 30.0, max(d, 0.0))) * 0.42 * glassAmount * fxB.w;
  if (d > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, shadow);
    return;
  }

  // Coverage across roughly one pixel rather than a hard test. A binary cutoff
  // gave the rounded corners a staircase — the SDF knows the exact distance to
  // the edge, so it can hand back a fraction instead.
  float cover = 1.0 - smoothstep(-0.7, 0.7, d);

  // Thickness profile: 0 at the rim, 1 well inside. This is what makes the slab
  // read as having depth instead of being a flat cutout. The band has to be wide
  // enough to see — at 26px the whole effect happened inside a hairline.
  // Tighter than before: concentrating the bend near the edge reads as glass,
  // spreading it wide reads as a water film.
  float depth = smoothstep(0.0, -max(tRim, 1.0), d);

  // Which way is out, from the gradient of the merged field rather than of one
  // rectangle. Where two panels have fused, this points along the joined surface
  // — including through the neck between them, which belongs to neither.
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(
    fieldAt(frag + e.xy) - fieldAt(frag - e.xy),
    fieldAt(frag + e.yx) - fieldAt(frag - e.yx)
  ) + 1e-6);

  // The bevel, as a quarter-round: u is 1 at the very edge and 0 where the slab
  // goes flat, so the surface stands on end at the rim and lies flat inside.
  //
  // Linear in distance rather than reusing depth, which is a smoothstep. The
  // smoothstep is the right shape for how much to frost and darken; it is the
  // wrong shape for a piece of geometry, and a bevel built on it has no edge.
  float u = 1.0 - clamp(-d / max(tRim, 1.0), 0.0, 1.0);

  // A real surface normal, with a z. This is the whole of the change: the old
  // version displaced the sample along the 2D normal by an amount that fell off
  // toward the middle, which smears the edge outwards but never refracts —
  // without a z there is no angle of incidence, so no index of refraction and no
  // thickness for light to cross.
  vec3 N = normalize(vec3(n * u, sqrt(max(1.0 - u * u, 1e-4))));

  // Refract the view ray at that surface, then carry it down through the slab to
  // the backdrop. Where it lands is what this pixel sees. Entering a denser
  // medium never reflects internally, so the grazing case at the rim is safe, but
  // the ray still has to be travelling downward before it can be divided by.
  float lod = mix(tLod.x, tLod.y, depth) * fxA.z;
  float spread = tDisp * fxA.y;
  vec2 pr = frag + lens(N, tIor - spread) * fxA.x;
  vec2 pg = frag + lens(N, tIor) * fxA.x;
  vec2 pb = frag + lens(N, tIor + spread) * fxA.x;

  // The bevel stays clear and splits the channels; the body is frosted and does
  // not. Dispersion is an edge effect — a few pixels of channel offset inside a
  // disc gathered over twenty is invisible, and paying three times the taps to
  // hide it there would be paying for nothing.
  vec3 sharp;
  sharp.r = behind(pr / res, lod).r;
  sharp.g = behind(pg / res, lod).g;
  sharp.b = behind(pb / res, lod).b;
  vec3 col = mix(sharp, gather(pg, lod, tBlur * depth * fxA.z), depth * fxA.z);

  // Nothing dims behind an open panel: the lift lives on the panel itself, so
  // darkening the rest of the screen would undo the point of it.

  // Darkening ramps with depth: light at the rim, heavy through the middle.
  //
  // A flat 72% everywhere was why the refraction could not be seen — it crushed
  // the bent wallpaper to near black exactly where the bending happens. Ramping
  // it also puts the darkness where the text is, so legibility and the effect
  // pull in the same direction instead of trading off.
  // Ultra clear, iOS 27's "极清" end of the scale: the wallpaper reads straight
  // through the panel and the depth comes entirely from the refraction. Only a
  // gentle ramp toward the middle, where the text sits.
  float darkness = hasUi > 0.5 ? mix(tDark.x, tDark.y, depth)
                               : mix(tDarkOff.x, tDarkOff.y, depth);
  col = mix(col, col * 0.30, darkness * glassAmount * fxA.w);

  // The signature of Liquid Glass is a thin, crisp specular line right at the
  // bevel — not a wide halo. Anything broad here reads as a second frame just
  // outside the DOM's 1px border.
  col += accent * pow(1.0 - depth, 3.0) * tGlow * glassAmount * fxB.y;

  // A point light in screen space, not a direction. Under a directional light
  // the band sits in the same place on the panel wherever the panel is, and a
  // highlight that never moves is the thing that stops it reading as an object.
  // With a point, walking the panel across the screen — or walking the light,
  // which is how the pointer drives it — slides the band along the edge.
  vec3 L = normalize(vec3(tLight.xy - frag, max(tLight.z, 1.0)));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float spec = pow(max(dot(N, normalize(L + V)), 0.0), max(tShine, 1.0));

  // Only on the bevel. The flat interior faces straight up, so without this the
  // whole panel would catch the same even sheen and the edge would stop being
  // the thing that catches light.
  spec *= 1.0 - depth;
  col += vec3(1.0) * spec * tSpec * glassAmount * fxB.x;

  // The surroundings, reflected. There is no environment map to sample, but
  // there is the backdrop, and a bevel steep enough to point somewhere other
  // than back at the viewer will show it. Blurred, because a sharp reflection of
  // the wallpaper on a 30px band reads as a bug.
  vec3 Rf = reflect(-V, N);
  vec3 env = behind((frag + Rf.xy * tThick * 2.0) / res, mix(2.0, 5.0, depth));
  col += env * tEnv * (1.0 - depth) * glassAmount * fxC.x;

  // The hairline border, from the same distance field. Drawn here rather than in
  // CSS so it lands exactly on the glass edge — two systems each drawing their
  // own border is what produced the doubled frame.
  float line = 1.0 - smoothstep(0.0, 1.6, abs(d + 0.8));
  col = mix(col, vec3(1.0), line * 0.20 * glassAmount * fxB.z);

  // Fade the panel into its own shadow across that same pixel of coverage.
  outColor = vec4(mix(vec3(0.0), col, cover), mix(shadow, 1.0, cover));
  return;

}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0.42, 0.46, 0.68];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

type Layer = {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uiTexture: WebGLTexture;
  u: Record<string, WebGLUniformLocation | null>;
};

/**
 * Names the GPU the context actually landed on, once per session.
 *
 * ADR 0016 puts the whole rendering plan on one assumption: that a window
 * reparented under WorkerW still gets a hardware context. If it silently falls
 * back to SwiftShader the power ceiling is unreachable and no amount of tuning
 * the glass will save it — so the fallback has to be loud rather than something
 * discovered later as "it feels warm". Read `window.__dmRenderer` in devtools on
 * the desktop-layer window to check it.
 */
/**
 * Says so, once per change of mind, and leaves the latest probe on
 * `window.__dmOcclusion`.
 *
 * ADR 0016's second power line — nothing drawn at all while covered — is the one
 * claim that cannot be checked by looking, because checking it means covering the
 * screen. So the run has to be readable afterwards: cover the desktop, take the
 * measurement, then come back and read why the answer was what it was.
 */
let lastVerdict: boolean | null = null;
function reportOcclusion(probe: Occlusion): void {
  (window as unknown as { __dmOcclusion: Occlusion }).__dmOcclusion = probe;
  if (probe.occluded === lastVerdict) return;
  lastVerdict = probe.occluded;
  console.info(
    probe.occluded
      ? `桌面层被遮挡，停止绘制。前台 ${probe.frontClass} ${probe.frontRect.join(",")}`
      : `桌面层在画：${probe.why || "前台窗口没盖满工作区"}。` +
        `前台 ${probe.frontClass || "—"} ${probe.frontRect.join(",")}，工作区 ${probe.workArea.join(",")}`,
  );
}

let reported = false;
function reportRenderer(gl: WebGL2RenderingContext): void {
  if (reported) return;
  reported = true;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = info
    ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  (window as unknown as { __dmRenderer: string }).__dmRenderer = renderer;
  if (isSoftware(renderer)) {
    console.error(`WebGL 掉进软件渲染：${renderer}。功耗达不到 ADR 0016 的硬线。`);
  } else {
    console.info(`WebGL 渲染器：${renderer}`);
  }
}

/** The software rasterisers a browser falls back to when no GPU is available. */
/** Exported so the settings panel can say the same thing about the same string. */
export function isSoftware(renderer: string): boolean {
  return /swiftshader|llvmpipe|softwarerasterizer|basic render|microsoft basic/i.test(renderer);
}

/**
 * One fullscreen quad running the shared shader.
 *
 * Two of these exist. The backdrop layer sits under the interface; the glass
 * layer sits above the scrim so refraction is not buried under the dimming, and
 * is fully transparent everywhere except inside the panel. A single layer cannot
 * do both jobs, because the scrim has to be above one and below the other.
 */
function makeLayer(zIndex: number, glassOnly: boolean, after: Element): Layer | null {
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    `position:absolute;inset:0;z-index:${zIndex};pointer-events:none;width:100%;height:100%`;
  after.after(canvas);

  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: true,
    // The backdrop layer sits inside the element the glass captures. A drawing
    // buffer that has already been swapped away reads back empty, which would
    // leave the glass refracting the interface over a black void.
    preserveDrawingBuffer: !glassOnly,
  });
  if (!gl) {
    canvas.remove();
    return null;
  }

  reportRenderer(gl);

  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    }
  } catch (err) {
    console.error("场景着色器失败", err);
    canvas.remove();
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(program);
  const names = [
    "res", "time", "accent", "wallpaper", "hasWallpaper", "wallAspect",
    "glassRect[0]", "glassRadius[0]", "glassCount", "glassAmount", "veil", "glassOnly", "ui", "hasUi",
    "tIor", "tThick", "tRim", "tDisp", "tLod", "tBlur", "tMerge", "tDark", "tDarkOff", "tGlow", "tSpec",
    "tShine", "tEnv", "tLight", "fxA", "fxB", "fxC",
  ];
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(program, n);

  const texture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.uniform1i(u.wallpaper!, 0);
  gl.uniform3f(u.accent!, 0.42, 0.46, 0.68);
  gl.uniform1f(u.hasWallpaper!, 0);
  gl.uniform1f(u.wallAspect!, 1.6);
  gl.uniform1f(u.glassAmount!, 0);
  gl.uniform1i(u.glassCount!, 0);
  gl.uniform3f(u.veil!, 0.5, 0.28, 0.56);
  gl.uniform1f(u.glassOnly!, glassOnly ? 1 : 0);
  gl.uniform1i(u.ui!, 1);
  gl.uniform1f(u.hasUi!, 0);
  applyTuning(gl, u, DEFAULT_TUNING);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const uiTexture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, uiTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.activeTexture(gl.TEXTURE0);

  return { canvas, gl, program, texture, uiTexture, u };
}

export type Scene = {
  setAccent(hex: string): void;
  setWallpaper(url: string): void;
  /** Pass an empty list to dissolve the glass. CSS pixels, y from the top. */
  setGlass(rects: GlassRect[]): void;
  setVeil(brightness: number): void;
  /**
   * Moves the light, in CSS pixels with y from the top. Null puts it back up and
   * to the left. Deliberately does not wake the scene: it is state the running
   * loop reads, and a pointer crossing the desktop is not on its own a reason to
   * start drawing again.
   */
  setLight(at: { x: number; y: number } | null): void;
  /** #15's bench only. Production never calls this, so the defaults stand. */
  setTuning(t: Tuning): void;
  /** Any interaction with our own interface proves somebody is looking. */
  wake(): void;
};

/**
 * Returns null when WebGL is unavailable, leaving the CSS layers in place.
 *
 * `watchOcclusion` belongs to the desktop surface only. The launchpad is hidden
 * whenever it is not in use, and a hidden window is not painted, so its loop
 * stops on its own — asking the shell about the *desktop's* occlusion would give
 * it the wrong answer anyway.
 */
export function startBackground(watchOcclusion: boolean): Scene | null {
  const wall = document.getElementById("wall");
  const scrim = document.getElementById("scrim");
  if (!wall || !scrim) return null;

  const backdrop = makeLayer(1, false, wall);
  if (!backdrop) return null;
  // Above the scrim (z 20), below the panels (z 21).
  const glass = makeLayer(20, true, scrim);
  if (!glass) {
    backdrop.canvas.remove();
    return null;
  }
  // A non-null alias: narrowing from the guards above does not survive into the
  // closures below.
  const glassLayer: Layer = glass;
  const layers = [backdrop, glassLayer];

  // The shader draws the atmosphere now, so the CSS blooms and veil step aside.
  // The scrim keeps painting — it dims the interface, which no shader can reach.
  for (const id of ["bloomA", "bloomB", "veil"]) {
    document.getElementById(id)?.style.setProperty("display", "none");
  }

  let hidden = false;
  let running = false;
  /**
   * Where the light sits, in CSS pixels with y from the top, or null for the
   * standing default up and to the left — the direction interfaces have lit
   * things from since before any of this was on a screen.
   */
  let light: { x: number; y: number } | null = null;
  /**
   * The panels the shader is drawing, as state it owns rather than as a list
   * handed in each frame.
   *
   * This is what lets a panel deform rather than fade: `life` carries it out of
   * `seed` — the thing that was clicked — and into `goal`, and back again when it
   * leaves. `goal` itself chases the DOM rectangle at a lag, so a panel that
   * moves is followed rather than teleported to.
   *
   * It also retires the rule that a glass panel may not move on entry. That rule
   * existed because the rectangle was measured once, in CSS pixels, and could not
   * track a CSS animation. Nothing is measured once any more.
   */
  type Live = {
    key: string;
    seed: Box;
    want: Box;
    goal: Box;
    life: number;
    leaving: boolean;
  };
  let live: Live[] = [];
  let lastNow = -1;

  /** Where each panel is this frame, after presence and lag are applied. */
  function shapes(): Box[] {
    return live.map((l) => mixBox(l.seed, l.goal, l.life * l.life * (3 - 2 * l.life)));
  }

  function advance(now: number): void {
    const dt = lastNow < 0 ? 16 : Math.min(64, now - lastNow);
    lastNow = now;
    // Presence over ~220ms; the chase is exponential, so it is framerate
    // independent rather than a fixed fraction per frame.
    const step = dt / 220;
    const chase = 1 - Math.pow(0.002, dt / 240);
    for (const l of live) {
      l.life = Math.min(1, Math.max(0, l.life + (l.leaving ? -step : step)));
      l.goal = mixBox(l.goal, l.want, chase);
    }
    live = live.filter((l) => !(l.leaving && l.life <= 0));
  }
  let amount = 0;

  // Capturing the interface is a full repaint into a texture, so it only runs
  // while a panel is actually open, and at a limited rate — the result is read
  // through a frosted lens, where a stale frame or two is invisible.
  const world = document.getElementById("world");
  const capture: Capture | null = world ? createCapture(world, 0.5) : null;
  const CAPTURE_INTERVAL = 1000 / 30;
  let lastCapture = -1e9;

  /**
   * Idle frame budget. The bands drift at 0.25 radians a second — at that speed
   * 15 frames a second is not a compromise, it is more than the motion can use. Measured on a 3440x1440 screen with
   * `scripts/measure-gpu.ps1`: 23.5% of the GPU at the monitor's rate, 3.2% at
   * 30, 1.8% here — which is the first number inside ADR 0016's 1-2%.
   */
  const IDLE_FRAME = 1000 / 15;
  /**
   * What a panel that has finished arriving costs. Measured with one open and
   * settled, the scene was taking 38% of the GPU: there was no budget at all in
   * this state, so it ran at whatever the monitor asked for — forever, for a
   * rectangle that is not moving.
   *
   * Nothing in it needs that. The bands drift at 0.25 radians a second, which
   * ADR 0016 already records 15fps as over-serving, and the panel itself is
   * still. Full rate is kept only while the glass is fading in, where the frames
   * are actually different from each other.
   */
  const OPEN_FRAME = 1000 / 30;
  let lastFrame = -1e9;

  function refreshUi(now: number): void {
    if (!capture) return;
    if (now - lastCapture < CAPTURE_INTERVAL) return;
    lastCapture = now;

    const { gl, u } = glassLayer;
    if (!capture.grab()) {
      // Falls back to the procedural backdrop rather than freezing on whatever
      // was captured last.
      gl.useProgram(glassLayer.program);
      gl.uniform1f(u.hasUi!, 0);
      return;
    }

    gl.useProgram(glassLayer.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, glassLayer.uiTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, capture.canvas);
    // The mip chain is what frosts the middle of the panel.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1f(u.hasUi!, 1);
    gl.activeTexture(gl.TEXTURE0);
  }

  function forEach(fn: (l: Layer) => void): void {
    for (const layer of layers) {
      layer.gl.useProgram(layer.program);
      fn(layer);
    }
  }

  function draw(now: number): void {
    if (hidden) {
      running = false;
      return;
    }
    requestAnimationFrame(draw);

    // With no panel up, nothing on screen moves but the atmosphere, and it drifts
    // slowly enough to live on a frame budget (see IDLE_FRAME). A millisecond of
    // slack because rAF lands a hair early as often as late — without it every
    // other slot is missed and the budget halves itself.
    advance(now);
    const idle = live.length === 0 && amount < 0.01;
    // Full rate only while the glass is on its way in or out; once it has
    // settled there is a budget again.
    const settling = amount > 0.001 && amount < 0.999;
    const budget = idle ? IDLE_FRAME : settling ? 0 : OPEN_FRAME;
    if (budget > 0 && now - lastFrame < budget - 1) return;
    lastFrame = now;

    const want = live.some((l) => !l.leaving) ? 1 : 0;
    // Quick: the panel it belongs to fades in over 200ms, and glass arriving
    // later than its own panel reads as lag.
    amount += (want - amount) * 0.34;
    if (Math.abs(want - amount) < 0.005) amount = want;
    const showingGlass = amount > 0.01;

    // Only while there is glass to draw, and only once the panel rectangles are
    // known — a capture with no panel on screen would be pure waste.
    const drawn = shapes();
    if (drawn.length > 0 && showingGlass) refreshUi(now);

    for (const layer of layers) {
      const { canvas, gl, u } = layer;
      const isGlass = layer === glassLayer;
      // The backdrop stays at half resolution whether or not a panel is open.
      //
      // It used to jump to full the moment glass appeared, on the grounds that
      // refraction bends a photograph and the seams show. The seams do show — but
      // not from here. The shader's `behind()` samples the captured interface
      // when there is one and computes `scene()` analytically when there is not,
      // and the capture that feeds the first is itself half resolution. Rendering
      // the backdrop at full only to have `drawElementImage` halve it again buys
      // the refraction nothing; it was four times the pixels for detail thrown
      // away one step later.
      //
      // What it did buy was the directly visible wallpaper, and that argument ran
      // backwards: the wallpaper was sharper while a panel covered part of it
      // than while nothing did, so opening search popped the whole screen into
      // focus. Now it looks the same either way.
      //
      // The glass layer still runs at device pixels: it draws hairlines and
      // rounded corners, and rendering those in CSS pixels then letting the
      // browser upscale is its own source of stepped edges. Capped at 2 so a 4K
      // ultrawide does not quadruple the fragment count for nothing.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // With no panel up the glass layer has nothing to draw but transparency,
      // and drawing that at device pixels was a full 3440x1440 pass per frame for
      // an image nobody can see. Collapsing the canvas to a pixel is what makes
      // it free: the resize clears it, and one stretched transparent pixel looks
      // exactly like the fullscreen transparent one it replaces.
      const scale = isGlass ? (showingGlass ? dpr : 0) : 0.5;
      const w = Math.max(1, Math.round(canvas.clientWidth * scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      gl.useProgram(layer.program);
      if (isGlass) {
        // Two units, rebound per frame: a shared context is easy to leave
        // pointing at the wrong texture after an upload.
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer.uiTexture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, layer.texture);
      }
      let rectsForScissor: number[] = [];
      if (drawn.length > 0) {
        // CSS pixels count y from the top; gl_FragCoord counts from the bottom.
        const rects: number[] = [];
        const radii: number[] = [];
        for (const r of drawn.slice(0, 6)) {
          rects.push(
            r.x * scale,
            (canvas.clientHeight - r.y - r.height) * scale,
            r.width * scale,
            r.height * scale,
          );
          radii.push(r.radius * scale);
        }
        gl.uniform4fv(u["glassRect[0]"]!, rects);
        gl.uniform1fv(u["glassRadius[0]"]!, radii);
        gl.uniform1i(u.glassCount!, radii.length);
        rectsForScissor = rects;
      }
      gl.uniform1f(u.glassAmount!, amount);
      // y flips: the shader works in gl_FragCoord, which counts up from the
      // bottom, and every rectangle handed in here counts down from the top.
      gl.uniform3f(
        u.tLight!,
        (light ? light.x : canvas.clientWidth * 0.25) * scale,
        (canvas.clientHeight - (light ? light.y : canvas.clientHeight * 0.15)) * scale,
        Math.max(w, h) * 0.75,
      );
      gl.uniform2f(u.res!, w, h);
      gl.uniform1f(u.time!, now / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // The glass is drawn only where there is glass. It used to shade the whole
      // screen at device pixels — nearly 20 million fragments on an ultrawide at
      // dpr 2 — for panels covering a couple of percent of it, and every fragment
      // outside them still walked the whole rectangle list to find out it had
      // nothing to draw.
      //
      // One scissored pass per panel. Overlapping boxes get shaded twice, which
      // costs a little and changes nothing: the shader picks the nearest surface
      // out of the same list either way, so both passes write the same pixel.
      if (isGlass && showingGlass && drawn.length > 0) {
        gl.enable(gl.SCISSOR_TEST);
        for (let i = 0; i < rectsForScissor.length; i += 4) {
          // Padding covers the shadow, which reaches 30px past the edge and is
          // drawn by the same pass.
          const pad = 34;
          const x = Math.floor(rectsForScissor[i]! - pad);
          const y = Math.floor(rectsForScissor[i + 1]! - pad);
          const bw = Math.ceil(rectsForScissor[i + 2]! + pad * 2);
          const bh = Math.ceil(rectsForScissor[i + 3]! + pad * 2);
          gl.scissor(
            Math.max(0, x),
            Math.max(0, y),
            Math.min(w - Math.max(0, x), bw),
            Math.min(h - Math.max(0, y), bh),
          );
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.disable(gl.SCISSOR_TEST);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
  }

  function resume(): void {
    if (running || hidden) return;
    running = true;
    requestAnimationFrame(draw);
  }
  resume();

  if (watchOcclusion) {
    setInterval(() => {
      // A panel of ours being open settles the question without asking: the user
      // is interacting with it, so somebody is looking. Consulting the shell here
      // was leaving the desktop surface paused with a panel open on top of it,
      // and the glass never appeared.
      if (live.length > 0) {
        if (hidden) {
          hidden = false;
          resume();
        }
        return;
      }
      void invoke<Occlusion>("desktop_occluded").then((probe) => {
        reportOcclusion(probe);
        hidden = probe.occluded;
        if (!probe.occluded) resume();
      });
    }, 1000);
  }

  return {
    setAccent(hex: string): void {
      const [r, g, b] = rgbOf(hex);
      forEach((l) => l.gl.uniform3f(l.u.accent!, r, g, b));
    },
    setVeil(brightness: number): void {
      // Bright wallpapers need more help before white text holds up. Darker top
      // and bottom than through the middle, which reads as depth rather than as
      // a grey sheet laid over the picture.
      const d = Math.min(0.66, Math.max(0.26, 0.2 + brightness * 0.52));
      forEach((l) =>
        l.gl.uniform3f(l.u.veil!, d + 0.2, Math.max(d - 0.06, 0.04), d + 0.14),
      );
    },
    setWallpaper(url: string): void {
      const img = new Image();
      // The asset protocol is a different origin from the page. An image can be
      // displayed cross-origin, but uploading one into WebGL taints the texture
      // and throws unless it was fetched with CORS.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        for (const layer of layers) {
          const { gl, u } = layer;
          try {
            gl.useProgram(layer.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, layer.texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            // The mip chain is the blur. WebGL2 builds them for any size.
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.uniform1f(u.wallAspect!, img.width / Math.max(img.height, 1));
            gl.uniform1f(u.hasWallpaper!, 1);
          } catch (err) {
            // Leaves hasWallpaper at 0, which keeps the backdrop translucent so
            // the CSS wallpaper still shows. Says so rather than going black.
            console.error("壁纸纹理上传失败，玻璃只会折射雾", err);
          }
        }
        resume();
      };
      img.onerror = () => console.error("壁纸纹理加载失败", url);
      img.src = url;
    },
    setLight(at: { x: number; y: number } | null): void {
      light = at;
    },
    setTuning(t: Tuning): void {
      forEach((l) => {
        l.gl.useProgram(l.program);
        applyTuning(l.gl, l.u, t);
      });
      hidden = false;
      resume();
    },
    wake(): void {
      hidden = false;
      resume();
    },
    setGlass(rects: GlassRect[]): void {
      const seen = new Set<string>();
      rects.forEach((r, i) => {
        const key = r.key ?? `#${i}`;
        seen.add(key);
        const box: Box = {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          radius: r.radius,
        };
        const had = live.find((l) => l.key === key);
        if (had) {
          had.want = box;
          had.leaving = false;
          return;
        }
        // New. It starts as whatever opened it and grows into place; `goal`
        // begins at the destination so the lag has nothing to catch up on and
        // the arrival is the deformation, not a slide as well.
        live.push({
          key,
          seed: r.from ?? pip(box),
          want: box,
          goal: box,
          life: 0,
          leaving: false,
        });
      });
      // Anything no longer named is on its way out, back into whatever it came
      // from. It keeps drawing until it has finished.
      for (const l of live) if (!seen.has(l.key)) l.leaving = true;

      // A panel being open is proof the surface is being looked at, whatever a
      // stale occlusion probe still says.
      if (rects.length > 0) hidden = false;
      resume();
    },
  };
}
