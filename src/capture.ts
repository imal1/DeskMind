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

function methodOn(ctx: CanvasRenderingContext2D): DrawElement | null {
  const bag = ctx as unknown as Record<string, unknown>;
  for (const name of METHODS) {
    if (typeof bag[name] === "function") {
      return (bag[name] as DrawElement).bind(ctx);
    }
  }
  return null;
}

export type Capture = {
  /** The canvas holding the most recent frame, ready to upload as a texture. */
  readonly canvas: HTMLCanvasElement;
  /** Redraws the source element. Returns false if the capture failed. */
  grab(): boolean;
  readonly scale: number;
};

/**
 * Returns null when the API is unavailable, which is a normal outcome — callers
 * fall back to composing the backdrop procedurally.
 *
 * `scale` trades fidelity for cost. The capture is only ever read through a
 * frosted, displaced lens, so half resolution is invisible in the result and
 * quarters the work of what is, after all, a full repaint of the interface.
 */
export function createCapture(source: Element, scale = 0.5): Capture | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  const draw = methodOn(ctx);
  if (!draw) return null;

  let broken = false;

  return {
    canvas,
    scale,
    grab(): boolean {
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

export function drawElementAvailable(): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  return ctx !== null && methodOn(ctx) !== null;
}
