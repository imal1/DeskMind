/**
 * The glass acceptance bench — issue #15.
 *
 * Drives the real shader (`startBackground`, the one the desktop runs) against a
 * fixed backdrop, with every term switchable and every constant on a slider.
 *
 * It exists because three manual acceptances failed the same way: "not right",
 * with no way to say which part was wrong. People judge differences, not
 * absolutes, so this hands over two of them — a term you can switch off, and a
 * reference you can put beside it.
 *
 * Not shipped: vite builds `index.html` alone, so `bench.html` is a dev-only
 * page and never enters a packaged build.
 */
import { DEFAULT_TUNING, startBackground, type Tuning } from "./background";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const wallEl = el("wall");
const panelEl = el("panel");
const panel2El = el("panel2");
const panels = [panelEl, panel2El];
const stageEl = el("stage");
const refEl = el("ref");
const splitEl = el("split");
const pickEl = el<HTMLInputElement>("filepick");

const scene = startBackground(false);
if (!scene) throw new Error("WebGL 拿不到上下文，验收台跑不起来");

let tuning: Tuning = structuredClone(DEFAULT_TUNING);

// ---------- test backdrops ----------

/**
 * A drawn backdrop rather than a photograph, because the conditions in #4's
 * standard are about straight lines and fine detail: a line crossing the bevel
 * has to bend continuously rather than break, and the frost has to destroy
 * detail without going blocky. A photograph has both somewhere, but never
 * reliably where the panel happens to be sitting.
 *
 * Returns the mean luminance it actually came out at, so "暗 < 0.3" and
 * "亮 > 0.7" are checked rather than asserted.
 */
function testBackdrop(bright: boolean): { url: string; mean: number } {
  const w = 1600;
  const h = 900;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;

  const base = bright ? "#d9dbe2" : "#12141b";
  const ink = bright ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.5)";
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // Low frequency, so the frost has something broad left to keep.
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, bright ? "#ffffff" : "#232838");
  grad.addColorStop(1, bright ? "#b9bdc9" : "#05060a");
  g.globalAlpha = 0.85;
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;

  // Straight lines at several angles. The bevel test is whether these bend
  // continuously through it or break.
  g.strokeStyle = ink;
  g.lineWidth = 1;
  for (let x = 0; x <= w; x += 40) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (let y = 0; y <= h; y += 40) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.lineWidth = 2;
  for (let i = -h; i < w; i += 130) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + h, h);
    g.stroke();
  }

  // Flat blocks, for judging the darkening against an even field.
  g.fillStyle = bright ? "rgba(0,0,0,.72)" : "rgba(255,255,255,.72)";
  for (let i = 0; i < 6; i++) g.fillRect(120 + i * 240, 120 + (i % 3) * 210, 120, 78);

  // A high-frequency patch. Frost that goes blocky shows here first.
  const cell = 3;
  for (let y = 520; y < 820; y += cell) {
    for (let x = 980; x < 1480; x += cell) {
      g.fillStyle = (x / cell + y / cell) % 2 === 0 ? base : ink;
      g.fillRect(x, y, cell, cell);
    }
  }

  // Measured, not assumed. Sampled off a small copy: the mean of a scaled image
  // is the mean of the original, and 1.4M pixels is a lot to walk for one number.
  const s = document.createElement("canvas");
  s.width = 80;
  s.height = 45;
  const sg = s.getContext("2d")!;
  sg.drawImage(c, 0, 0, 80, 45);
  const data = sg.getImageData(0, 0, 80, 45).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
  }
  return { url: c.toDataURL("image/png"), mean: sum / (data.length / 4) };
}

function useBackdrop(url: string, mean: number | null): void {
  wallEl.style.backgroundImage = `url(${url})`;
  scene!.setWallpaper(url);
  if (mean !== null) {
    scene!.setVeil(mean);
    el("meanout").textContent = `平均亮度 ${mean.toFixed(3)}（#4 的条件：暗 < 0.3，亮 > 0.7）`;
  } else {
    el("meanout").textContent = "自选图片，亮度未测";
  }
}

// ---------- the panel and its glass rectangle ----------

/** Keeps the shader's rectangle on the DOM panel, which is the whole contract. */
function syncGlass(): void {
  const s = stageEl.getBoundingClientRect();
  scene!.setGlass(
    panels.map((p) => {
      const b = p.getBoundingClientRect();
      return {
        // Identity, so dragging follows a panel instead of replacing it — which
        // is what makes the damped lag visible at all.
        key: p.id,
        x: b.left - s.left,
        y: b.top - s.top,
        width: b.width,
        height: b.height,
        radius: parseFloat(getComputedStyle(p).borderTopLeftRadius) || 24,
      };
    }),
  );
}

function placePanel(node: HTMLElement, x: number, y: number): void {
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  syncGlass();
}

// Dragging is not decoration: #20's condition is that the darkening stays smooth
// as a panel crosses a light-to-dark boundary, and that can only be judged by
// moving one across it.
let drag: { node: HTMLElement; dx: number; dy: number } | null = null;
for (const node of panels) {
  node.addEventListener("pointerdown", (e) => {
    const b = node.getBoundingClientRect();
    drag = { node, dx: e.clientX - b.left, dy: e.clientY - b.top };
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);
  });
  node.addEventListener("pointermove", (e) => {
    if (!drag || drag.node !== node) return;
    const s = stageEl.getBoundingClientRect();
    placePanel(node, e.clientX - s.left - drag.dx, e.clientY - s.top - drag.dy);
  });
  node.addEventListener("pointerup", () => {
    drag = null;
    node.classList.remove("dragging");
  });
}

// ---------- controls ----------

const TERMS: { key: keyof Tuning["on"]; label: string }[] = [
  { key: "refract", label: "折射（边缘位移）" },
  { key: "dispersion", label: "色散（通道分离）" },
  { key: "frost", label: "磨砂" },
  { key: "darken", label: "压暗" },
  { key: "specular", label: "边缘高光" },
  { key: "env", label: "环境反射" },
  { key: "glow", label: "accent 晕" },
  { key: "border", label: "发丝边框" },
  { key: "shadow", label: "投影" },
];

type Knob = {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
};

const KNOBS: Knob[] = [
  { label: "折射率", min: 1, max: 2.4, step: 0.01, get: () => tuning.ior, set: (v) => (tuning.ior = v) },
  { label: "厚度", min: 0, max: 160, step: 1, get: () => tuning.thickness, set: (v) => (tuning.thickness = v) },
  { label: "斜面宽", min: 1, max: 140, step: 1, get: () => tuning.rim, set: (v) => (tuning.rim = v) },
  { label: "色散", min: 0, max: 0.3, step: 0.005, get: () => tuning.dispersion, set: (v) => (tuning.dispersion = v) },
  { label: "磨砂 边", min: 0, max: 8, step: 0.1, get: () => tuning.lod[0], set: (v) => (tuning.lod[0] = v) },
  { label: "磨砂 心", min: 0, max: 8, step: 0.1, get: () => tuning.lod[1], set: (v) => (tuning.lod[1] = v) },
  { label: "模糊半径", min: 0, max: 80, step: 1, get: () => tuning.blur, set: (v) => (tuning.blur = v) },
  { label: "融合距离", min: 0, max: 120, step: 1, get: () => tuning.merge, set: (v) => (tuning.merge = v) },
  { label: "压暗 下限", min: 0, max: 1, step: 0.01, get: () => tuning.dark[0], set: (v) => (tuning.dark[0] = v) },
  { label: "压暗 上限", min: 0, max: 1, step: 0.01, get: () => tuning.dark[1], set: (v) => (tuning.dark[1] = v) },
  { label: "目标亮度", min: 0.02, max: 0.5, step: 0.005, get: () => tuning.target, set: (v) => (tuning.target = v) },
  { label: "色调偏移", min: 0, max: 0.3, step: 0.01, get: () => tuning.tint, set: (v) => (tuning.tint = v) },
  { label: "accent 晕", min: 0, max: 0.6, step: 0.01, get: () => tuning.glow, set: (v) => (tuning.glow = v) },
  { label: "高光", min: 0, max: 1.5, step: 0.01, get: () => tuning.specular, set: (v) => (tuning.specular = v) },
  { label: "高光锐度", min: 1, max: 120, step: 1, get: () => tuning.shine, set: (v) => (tuning.shine = v) },
  { label: "环境反射", min: 0, max: 0.6, step: 0.01, get: () => tuning.env, set: (v) => (tuning.env = v) },
];

function push(): void {
  scene!.setTuning(tuning);
}

function buildToggles(): void {
  el("toggles").replaceChildren(
    ...TERMS.map(({ key, label }) => {
      const row = document.createElement("label");
      row.className = "row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = tuning.on[key];
      box.addEventListener("change", () => {
        tuning.on[key] = box.checked;
        push();
      });
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      return row;
    }),
  );
}

function buildKnobs(): void {
  el("knobs").replaceChildren(
    ...KNOBS.map((k) => {
      const row = document.createElement("div");
      row.className = "knob";
      const name = document.createElement("span");
      name.textContent = k.label;
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(k.min);
      range.max = String(k.max);
      range.step = String(k.step);
      range.value = String(k.get());
      const out = document.createElement("output");
      out.textContent = String(k.get());
      range.addEventListener("input", () => {
        k.set(parseFloat(range.value));
        out.textContent = range.value;
        push();
      });
      row.append(name, range, out);
      return row;
    }),
  );
}

// ---------- wiring ----------

const backdrops = { dark: testBackdrop(false), bright: testBackdrop(true) };

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-bg]")) {
  b.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-bg]")) other.classList.remove("on");
    b.classList.add("on");
    const chosen = backdrops[b.dataset.bg as "dark" | "bright"];
    useBackdrop(chosen.url, chosen.mean);
  });
}

/** One file input serves both pickers; this says what the next pick is for. */
let pickFor: "bg" | "ref" = "bg";
el("bgfile").addEventListener("click", () => {
  pickFor = "bg";
  pickEl.click();
});
el("reffile").addEventListener("click", () => {
  pickFor = "ref";
  pickEl.click();
});
pickEl.addEventListener("change", () => {
  const file = pickEl.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (pickFor === "bg") {
    for (const other of document.querySelectorAll("[data-bg]")) other.classList.remove("on");
    useBackdrop(url, null);
  } else {
    refEl.style.backgroundImage = `url(${url})`;
    document.body.classList.remove("noref");
  }
  pickEl.value = "";
});
el("refclear").addEventListener("click", () => {
  refEl.style.backgroundImage = "";
  document.body.classList.add("noref");
});

// The divider clips the reference rather than moving it, so both halves stay in
// register and the seam compares the same pixel column.
function setSplit(x: number): void {
  const s = stageEl.getBoundingClientRect();
  const clamped = Math.min(Math.max(x - s.left, 0), s.width);
  splitEl.style.left = `${clamped}px`;
  refEl.style.clipPath = `inset(0 0 0 ${clamped}px)`;
}
splitEl.addEventListener("pointerdown", (e) => {
  splitEl.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent): void => setSplit(ev.clientX);
  const up = (): void => {
    splitEl.removeEventListener("pointermove", move);
    splitEl.removeEventListener("pointerup", up);
  };
  splitEl.addEventListener("pointermove", move);
  splitEl.addEventListener("pointerup", up);
});

el("export").addEventListener("click", () => {
  const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  el<HTMLTextAreaElement>("exported").value =
    `export const DEFAULT_TUNING: Tuning = {\n` +
    `  ior: ${tuning.ior},\n` +
    `  thickness: ${f(tuning.thickness)},\n` +
    `  rim: ${f(tuning.rim)},\n` +
    `  dispersion: ${tuning.dispersion},\n` +
    `  lod: [${f(tuning.lod[0])}, ${f(tuning.lod[1])}],\n` +
    `  blur: ${f(tuning.blur)},\n` +
    `  dark: [${tuning.dark[0]}, ${tuning.dark[1]}],\n` +
    `  target: ${tuning.target},\n` +
    `  tint: ${tuning.tint},\n` +
    `  glow: ${tuning.glow},\n` +
    `  specular: ${tuning.specular},\n` +
    `  shine: ${f(tuning.shine)},\n` +
    `  env: ${tuning.env},\n` +
    `  on: { ${TERMS.map(({ key }) => `${key}: ${tuning.on[key]}`).join(", ")} },\n` +
    `};`;
});

el("reset").addEventListener("click", () => {
  tuning = structuredClone(DEFAULT_TUNING);
  buildToggles();
  buildKnobs();
  push();
});

// The light follows the pointer here, which is the quickest way to see whether
// the band actually slides along the edge — this ticket's whole condition.
// Holding shift parks it, for judging a still frame.
let lightLocked = false;
stageEl.addEventListener("pointermove", (e) => {
  if (lightLocked || drag) return;
  const s = stageEl.getBoundingClientRect();
  scene!.setLight({ x: e.clientX - s.left, y: e.clientY - s.top });
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") lightLocked = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") lightLocked = false;
});

window.addEventListener("resize", syncGlass);

buildToggles();
buildKnobs();
useBackdrop(backdrops.dark.url, backdrops.dark.mean);
panelEl.style.width = "520px";
panel2El.style.width = "180px";
placePanel(panelEl, 280, 200);
placePanel(panel2El, 320, 430);
setSplit(window.innerWidth * 0.62);
push();

// Nothing here ever "opens" a panel, so the shader's own fade-in would leave the
// glass parked at zero. Ask for it directly and leave it up.
scene.wake();
