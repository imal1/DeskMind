/**
 * Capturing the live interface into a texture, via the HTML-in-Canvas API.
 *
 * This is what lets the panel glass refract the *interface* — tiles, text, the
 * rail — instead of only the wallpaper behind it. Refracting a static photograph
 * is what made the earlier glass feel flat: real glass distorts whatever is under
 * it, and under a panel there is content, not just a picture.
 *
 * The API is behind `--enable-blink-features=CanvasDrawElement` (see
 * `spikes/s5-drawelement/FINDINGS.md`) and has gone by more than one method name,
 * so everything here is feature-detected and every caller must cope with `null`.
 */

/** Method names the proposal has used. Checked in order. */
const METHODS = ["drawElementImage", "drawElement"] as const;

type DrawElement = (el: Element, x: number, y: number) => void;

function methodOn(ctx: CanvasRenderingContext2D): { name: string; draw: DrawElement } | null {
  const bag = ctx as unknown as Record<string, unknown>;
  for (const name of METHODS) {
    if (typeof bag[name] === "function") {
      return { name, draw: (bag[name] as DrawElement).bind(ctx) };
    }
  }
  return null;
}

/**
 * Says out loud which name was found, or that none was, and leaves the answer on
 * `window.__dmCapture` — the same treatment `window.__dmRenderer` gets in
 * `background.ts`, and for the same reason.
 *
 * Losing this API is the one failure here that looks like a decision rather than
 * a fault: the glass keeps working, quietly refracting only the wallpaper and
 * dropping to the lighter darkness ramp. That is a different look, and judging it
 * against criteria written for the real one wastes the whole acceptance run. So
 * the degraded path announces itself instead of waiting to be noticed.
 */
let told = false;
function reportCapture(name: string | null): void {
  if (told) return;
  told = true;
  (window as unknown as { __dmCapture: string }).__dmCapture = name ?? "none";
  if (name) {
    console.info(`界面捕获：ctx.${name}`);
  } else {
    console.error(
      "界面捕获不可用：玻璃只会折射壁纸，压暗换成轻档（0.06→0.26）。" +
        "检查 WebView2 是否带上了 --enable-blink-features=CanvasDrawElement。",
    );
  }
}

export type Capture = {
  /** The canvas holding the most recent frame, ready to upload as a texture. */
  readonly canvas: HTMLCanvasElement;
  /**
   * Redraws the source element at `scale`, and returns false if it failed.
   *
   * The scale is per call rather than fixed at construction because what the
   * capture is worth depends on what is happening: a still interface is being
   * studied through the bevel and wants every pixel, one mid-interaction is
   * seen through frost and motion and does not.
   */
  grab(scale: number): boolean;
};

/**
 * Returns null when the API is unavailable, which is a normal outcome — callers
 * fall back to composing the backdrop procedurally.
 *
 * Scale is chosen per grab; see `Capture.grab`.
 */
export function createCapture(source: Element): Capture | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  const found = methodOn(ctx);
  reportCapture(found?.name ?? null);
  if (!found) return null;
  const draw = found.draw;

  let broken = false;

  return {
    canvas,
    grab(scale: number): boolean {
      if (broken) return false;

      const w = Math.max(1, Math.round(window.innerWidth * scale));
      const h = Math.max(1, Math.round(window.innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      try {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        draw(source, 0, 0);
        return true;
      } catch (err) {
        // One failure is enough to stop trying: if the element cannot be drawn
        // it will not start working later, and throwing once per frame would
        // drown the console.
        broken = true;
        console.warn("界面捕获失败，玻璃退回程序化合成", err);
        return false;
      }
    },
  };
}

