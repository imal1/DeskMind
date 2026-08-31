import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { rank } from "./match";
import { deskStats, moveInGrid, scatterAt, sinceTidy, tiltAt, type ArrowKey } from "./desk";
import { isSoftware, startBackground, type Scene } from "./background";

type LaunchTarget = {
  name: string;
  path: string;
  source: "startmenu" | "desktop" | "added";
};

type StoredZone = { name: string; items: string[] };
/** `hidden` is backend-owned: it arrives here but is written by `write_hidden`. */
type Zones = { zones: StoredZone[]; pinned: string[]; hidden?: string[] };

const win = getCurrentWindow();

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const tabsEl = el("tabs");
const gridEl = el("grid");
const glowEl = el("tileglow");
const stageEl = el("stage");
const statusWhenEl = el("statuswhen");
const statusRowsEl = el("statusrows");
const tidyUnzonedEl = el<HTMLButtonElement>("tidyunzoned");
const summaryEl = el("summary");
const clockEl = el("clock");
const scrimEl = el("scrim");
const searchEl = el("search");
const resultsEl = el("results");
const queryEl = el<HTMLInputElement>("q");
const heroEl = el("hero");
const heroIcoEl = el("heroico");
const heroMetaEl = el("herometa");
const heroTitleEl = el("herotitle");
const heroPathEl = el("heropath");
const ctxEl = el("ctx");
const tidyBtn = el<HTMLButtonElement>("tidybtn");
const toastEl = el("toast");
const toastTitleEl = el("toasttitle");
const toastSubEl = el("toastsub");
const toastActEl = el<HTMLButtonElement>("toastact");

/**
 * Movement is decoration here — nothing on screen means anything by moving — so
 * everything that displaces or scales is skipped outright when the user has
 * asked for less of it, and the state it was travelling towards is simply the
 * state they get. The stylesheet does the same for the parts CSS owns.
 */
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

let all: LaunchTarget[] = [];
let iconOf = new Map<string, string>();
/** Persisted zones. Tab 0 is always a synthetic "全部" and is not stored. */
let stored: StoredZone[] = [];
/** Paths the user pinned. They sort to the front of whichever zone they are in. */
let pinned = new Set<string>();
/**
 * Paths taken off the grid, including out of 全部. Hiding is about the look of
 * the desktop only — search reads `all`, not this filtered view, so a hidden
 * target is still one keystroke away.
 */
let hiddenPaths = new Set<string>();
/** Milliseconds since the epoch, or 0 for "never tidied". */
let lastTidy = 0;
/** Columns the grid actually laid out, measured after each paint. */
let cols = 1;
/** The zone set as it was before the last tidy, for undo. */
let previous: Zones | null = null;
let zone = 0;
let tile = 0;

let searchOpen = false;
let results: LaunchTarget[] = [];
let pick = 0;

const MAX_RESULTS = 200;

function tabNames(): string[] {
  return ["全部", ...stored.map((z) => z.name)];
}

/** Everything the grid may show: every target the user has not hidden. */
function onDesktop(): LaunchTarget[] {
  return all.filter((t) => !hiddenPaths.has(t.path));
}

function inZone(): LaunchTarget[] {
  const shown = onDesktop();
  const base =
    zone === 0
      ? shown
      : (() => {
          const members = new Set(stored[zone - 1]?.items ?? []);
          return shown.filter((t) => members.has(t.path));
        })();

  // Pinned first, otherwise the order the backend produced. A stable partition
  // rather than a sort, so unpinned items keep their alphabetical run.
  if (pinned.size === 0) return base;
  return [
    ...base.filter((t) => pinned.has(t.path)),
    ...base.filter((t) => !pinned.has(t.path)),
  ];
}

/**
 * Paints a target's icon onto `node`, falling back to its initial. Extraction
 * genuinely fails for some entries — Store shortcuts, broken links — and a bare
 * plate reads as a rendering bug rather than as missing data.
 */
function iconStyle(node: HTMLElement, target: LaunchTarget): void {
  const url = iconOf.get(target.path);
  node.style.backgroundImage = url ? `url("${url}")` : "";
  node.textContent = url ? "" : [...target.name][0]?.toUpperCase() ?? "?";
}

/** Where a launch target came from, in the user's words. */
function sourceName(t: LaunchTarget): string {
  if (t.source === "desktop") return "桌面";
  if (t.source === "added") return "手动添加";
  return "开始菜单";
}

/** Everything we can say about a target without opening it. */
function kindOf(t: LaunchTarget): string {
  const dot = t.name.lastIndexOf(".");
  const ext = t.path.slice(t.path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "lnk") return "程序";
  if (ext === "url") return "网页快捷方式";
  if (dot > 0 || t.path.includes(".")) return `${ext.toUpperCase()} 文件`;
  return "文件夹";
}

function selected(): LaunchTarget | undefined {
  return inZone()[tile];
}

// ---------- detail panel ----------

/** The target the hero is currently showing, so it only re-rises for a new one. */
let heroPath = "";

function paintHero(): void {
  const t = selected();
  if (!t) {
    heroEl.classList.add("hide");
    heroPath = "";
    return;
  }
  heroEl.classList.remove("hide");
  iconStyle(heroIcoEl, t);
  heroMetaEl.textContent = [
    pinned.has(t.path) ? "已固定" : null,
    zoneOf(t),
    sourceName(t),
    kindOf(t),
  ]
    .filter(Boolean)
    .join(" · ");
  heroTitleEl.textContent = t.name;
  heroPathEl.textContent = t.path;

  // Replayed only when the selection moved. `paintHero` runs on every repaint of
  // the grid, and a hero that rose again each time a tile was pinned or a zone
  // was written would read as a flicker rather than as a change of subject.
  if (t.path !== heroPath) {
    heroPath = t.path;
    heroEl.style.animation = "none";
    void heroEl.offsetWidth;
    heroEl.style.animation = "";
  }
}

// ---------- context menu ----------

function closeCtx(): void {
  ctxEl.classList.add("hide");
  refreshGlass();
}

function menuItem(label: string, act: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ctxitem";
  b.textContent = label;
  b.addEventListener("click", () => {
    closeCtx();
    act();
  });
  return b;
}

function menuSep(): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "ctxsep";
  return sep;
}

/** Shows the one menu element at (x, y), nudged back inside the viewport. */
function openMenu(nodes: HTMLElement[], x: number, y: number): void {
  ctxEl.replaceChildren(...nodes);

  // Show first so the measured size is real, then nudge.
  ctxEl.classList.remove("hide");
  const box = ctxEl.getBoundingClientRect();
  ctxEl.style.left = `${Math.min(x, window.innerWidth - box.width - 12)}px`;
  ctxEl.style.top = `${Math.min(y, window.innerHeight - box.height - 12)}px`;
  refreshGlass();
}

function openCtx(t: LaunchTarget, x: number, y: number): void {
  const head = document.createElement("div");
  head.id = "ctxhead";
  head.textContent = t.name;

  // 打开 leads, because a right-click menu that cannot open the thing it is about
  // sends the user back out to find another way in.
  const nodes: HTMLElement[] = [
    head,
    menuItem("打开", () => void run(t)),
    menuItem("打开文件位置", () => void revealIn(t)),
    menuSep(),
    menuItem(pinned.has(t.path) ? "取消固定" : "固定", () => togglePin(t)),
    menuItem("从桌面隐藏", () => void hideTarget(t)),
    menuItem("复制路径", () => void copyPath(t)),
  ];

  // Only dropped-in targets can be removed: a scanned one would come straight
  // back on the next scan. "移除" and not "删除" — the file is not touched.
  if (t.source === "added") {
    nodes.push(menuItem("移除启动项", () => void removeTarget(t)));
  }

  // Listed flat rather than behind a submenu: with a handful of zones the extra
  // rows cost less than a hover-to-open nested menu would.
  const current = zoneOf(t);
  const elsewhere = stored.filter((z) => z.name !== current);
  if (elsewhere.length > 0) {
    nodes.push(menuSep());
    for (const z of elsewhere) {
      nodes.push(menuItem(`移到「${z.name}」`, () => moveTo(t, z.name)));
    }
  }

  openMenu(nodes, x, y);
}

/**
 * The menu for empty stage, standing in for the desktop's own.
 *
 * ADR 0015 accepts that the desktop surface covers the real icons, on the
 * condition that deskmind takes over what they were for. Right-clicking bare
 * desktop was the part still missing: the stage swallowed the event and offered
 * nothing back, so refresh, display settings, personalise and — worst — any way
 * out short of hunting for the tray icon were simply gone.
 *
 * 新建 is deliberately absent. It writes a file into the desktop folder, and
 * whether deskmind may do that is a decision of its own, not a gap to plug here.
 */
function openStageMenu(x: number, y: number): void {
  openMenu(
    [
      menuItem("刷新", () => void reloadTargets()),
      menuSep(),
      menuItem("整理", () => void doTidy()),
      menuItem("设置", () => void openSettings()),
      menuSep(),
      // Handed to the shell exactly like a launch target: ms-settings: is a URI
      // the shell already knows how to open, so this needs no new command.
      menuItem("显示设置", () => void invoke("launch", { path: "ms-settings:display" })),
      menuItem("个性化", () => void invoke("launch", { path: "ms-settings:personalization" })),
      menuSep(),
      menuItem("退出 deskmind", () => void invoke("quit")),
    ],
    x,
    y,
  );
}

/** Re-reads launch targets and zones from disk. What 刷新 means here. */
async function reloadTargets(): Promise<void> {
  try {
    all = await invoke<LaunchTarget[]>("list_targets");
    await loadZones();
  } catch (err) {
    toast("刷新失败", String(err));
    return;
  }
  paint();
  void loadIcons();
  toast(`已刷新 ${all.length} 个启动项`);
}

// ---------- grid ----------

function paintTabs(): void {
  const names = tabNames();
  zone = Math.min(zone, names.length - 1);
  tabsEl.replaceChildren(
    ...names.map((name, i) => {
      const b = document.createElement("button");
      b.className = i === zone ? "tab on" : "tab";
      b.textContent = name;
      b.addEventListener("click", () => {
        zone = i;
        tile = 0;
        paint();
      });

      // Tabs are drop targets for tiles. Dropping on 全部 (index 0) means "no
      // zone" rather than "every zone", which is the only sensible reading and
      // gives the user a way to undo a placement without opening settings.
      b.addEventListener("dragover", (e) => {
        e.preventDefault();
        b.classList.add("dropping");
      });
      b.addEventListener("dragleave", () => b.classList.remove("dropping"));
      b.addEventListener("drop", (e) => {
        e.preventDefault();
        b.classList.remove("dropping");
        const path = e.dataTransfer?.getData("application/x-deskmind-target");
        const target = all.find((t) => t.path === path);
        if (target) moveTo(target, i === 0 ? null : (names[i] ?? null));
      });
      return b;
    }),
  );
}

/**
 * Every tile the grid is currently showing. The grid holds one thing that is not
 * a tile — the selection glow — so the tiles are asked for by name rather than
 * taken as "the children".
 */
function tileNodes(): HTMLElement[] {
  return [...gridEl.querySelectorAll<HTMLElement>(".tile")];
}

/**
 * Clears what a paint owns. The glow is deliberately left standing: it is the
 * one element whose fade has to survive the repaint that moved the selection.
 */
function clearGrid(): void {
  for (const node of gridEl.querySelectorAll(".tile, #gridempty")) node.remove();
  // The leaning tile is one of those, and holding a detached node would keep it
  // alive and send the next flattening to a tile nobody can see.
  tilted = null;
}

/** The tile the pointer is leaning, so it can be laid flat once the pointer goes. */
let tilted: HTMLElement | null = null;

/**
 * Publishes the width the grid actually gave a tile, which the lean's viewing
 * distance is a multiple of. Measured rather than derived from the CSS for the
 * same reason the column count is: `auto-fill` with a `1fr` track means the
 * window decides, and a lean pinned to a pixel distance would flatten out as
 * that window widened.
 */
function publishTileWidth(): void {
  const first = tileNodes()[0];
  if (first) gridEl.style.setProperty("--tile-w", `${first.offsetWidth}px`);
}

/** How far past the tile the glow spreads on every side, from the checklist. */
const GLOW_INSET = 0.16;

/**
 * Puts the glow under the selected tile. Measured here rather than expressed as
 * a CSS inset because the glow is not the tile's child — being nobody's child is
 * what lets it outlive the repaint, and so what lets it fade rather than vanish.
 *
 * Placed rather than travelled: only its appearing and going are animated, so
 * moving it costs nothing and needs no transition to be suppressed first.
 */
function paintGlow(): void {
  const node = tileNodes()[tile];
  if (!node) {
    glowEl.classList.remove("on");
    return;
  }
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  glowEl.style.width = `${w * (1 + GLOW_INSET * 2)}px`;
  glowEl.style.height = `${h * (1 + GLOW_INSET * 2)}px`;
  glowEl.style.transform =
    `translate(${node.offsetLeft - w * GLOW_INSET}px, ${node.offsetTop - h * GLOW_INSET}px)`;
  glowEl.classList.add("on");
}

function setTilt(node: HTMLElement | null, x = 0, y = 0): void {
  if (tilted && tilted !== node) {
    tilted.style.removeProperty("--px");
    tilted.style.removeProperty("--py");
  }
  tilted = node;
  if (!node) return;
  node.style.setProperty("--px", String(x));
  node.style.setProperty("--py", String(y));
}

/**
 * Leans the selected tile towards a pointer at these coordinates, or lays it
 * flat when the pointer is somewhere else. Works off the point rather than off
 * the event's target so that it can also be called straight after a repaint,
 * when the node the pointer was over has already been thrown away.
 */
function leanAt(x: number, y: number): void {
  const node = tileNodes()[tile];
  if (!node) return setTilt(null);
  const box = node.getBoundingClientRect();
  const outside = x < box.left || x > box.right || y < box.top || y > box.bottom;
  if (outside) return setTilt(null);
  setTilt(node, tiltAt(x, box.left, box.width), tiltAt(y, box.top, box.height));
}

/** Hands every tile the offset and the wait issue #9's checklist gave its position. */
function markScatter(): void {
  tileNodes().forEach((node, i) => {
    const s = scatterAt(i);
    node.style.setProperty("--sx", `${s.x}px`);
    node.style.setProperty("--sy", `${s.y}px`);
    node.style.setProperty("--sd", `${s.delay}ms`);
  });
}

let settleTimer = 0;

/** A full scatter: its own .62s, plus the wait the last staggered tile sits out. */
const SCATTER_MS = 620 + scatterAt(11).delay;

/**
 * Resolves once the scatter has had time to play. Awaited alongside the work
 * rather than before it, so it costs nothing whenever the work is the slower of
 * the two — which is every real tidy. Undo is the case it exists for: that one
 * writes a file and comes straight back, and without the wait the tiles would
 * snap to an offset they never had time to travel to.
 */
function scatterHold(): Promise<void> {
  if (reduced.matches) return Promise.resolve();
  return new Promise((done) => window.setTimeout(done, SCATTER_MS));
}

/** Throws the field apart for as long as a tidy is out. */
function scatterTiles(): void {
  if (reduced.matches) return;
  markScatter();
  gridEl.classList.remove("settle");
  gridEl.classList.add("scatter");
}

/**
 * Drops the field home. Runs after the repaint that brought the new zones in, so
 * the tiles it finds are fresh ones standing at rest: they are put back where
 * the scattered ones were for exactly one frame, then let go.
 *
 * Every way a tidy can end comes through here — filed, failed, undone — because
 * a field left scattered is the app still looking like it is thinking.
 */
function settleTiles(): void {
  gridEl.classList.remove("scatter", "settle");
  if (reduced.matches) return;
  markScatter();
  gridEl.classList.add("instant", "scatter");
  void gridEl.offsetWidth;
  gridEl.classList.remove("instant", "scatter");
  gridEl.classList.add("settle");
  window.clearTimeout(settleTimer);
  // Dropped once the last of the staggered tiles has landed. Held any longer and
  // the next selection would inherit the stagger and lift late.
  settleTimer = window.setTimeout(() => gridEl.classList.remove("settle"), 500 + scatterAt(11).delay + 60);
}

function paintGrid(): void {
  const items = inZone();
  summaryEl.textContent = `共 ${all.length} 项 · 图标 ${iconOf.size}`;

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.id = "gridempty";
    empty.textContent =
      stored.length === 0 ? "还没有分区，点右上角「整理」让 AI 提一套" : "这个分区还是空的";
    clearGrid();
    gridEl.append(empty);
    cols = 1;
    paintGlow();
    paintHero();
    return;
  }

  tile = Math.min(tile, items.length - 1);

  clearGrid();
  gridEl.append(
    ...items.map((t, i) => {
      const node = document.createElement("div");
      node.className = i === tile ? "tile on" : "tile";
      node.title = t.path;
      // What a launch matches its tile by, rather than reading the tooltip.
      node.dataset.path = t.path;
      node.addEventListener("click", (e) => {
        tile = i;
        paintGrid();
        // The pointer has not moved, but the tile under it has been replaced.
        // Without this the newly selected tile sits flat until the pointer stirs.
        leanAt(e.clientX, e.clientY);
      });
      node.addEventListener("dblclick", () => void run(t));
      node.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        tile = i;
        paintGrid();
        openCtx(t, e.clientX, e.clientY);
      });

      // A private MIME type, so a tile dragged out of the window is not mistaken
      // for text by whatever it lands on. Files dragged *in* from Explorer are
      // handled by `acceptDrops`, which adds them as launch targets without
      // touching the files themselves.
      node.draggable = true;
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("application/x-deskmind-target", t.path);
        node.classList.add("dragging");
      });
      node.addEventListener("dragend", () => node.classList.remove("dragging"));

      const ico = document.createElement("div");
      ico.className = "tileico";
      iconStyle(ico, t);

      const name = document.createElement("div");
      name.className = "tilename";
      name.textContent = t.name;

      // The face is absolute inside the cell, so the 5:3 ratio is the cell's own
      // and a long name crops instead of growing its row.
      const face = document.createElement("div");
      face.className = "tileface";
      face.append(ico, name);
      node.append(face);
      if (pinned.has(t.path)) {
        const dot = document.createElement("div");
        dot.className = "tilepin";
        node.append(dot);
      }
      return node;
    }),
  );

  cols = measureCols();
  publishTileWidth();
  tileNodes()[tile]?.scrollIntoView({ block: "nearest" });
  // After the scroll, so the glow is placed where the tile came to rest.
  paintGlow();
  paintHero();
}

/**
 * How many tiles the grid put on the first row. Measured rather than derived from
 * the CSS, because `auto-fill` is the whole point: the column count is whatever
 * the window worked out, and the keyboard has to agree with what is on screen.
 */
function measureCols(): number {
  const kids = tileNodes();
  const first = kids[0];
  if (!first) return 1;
  const top = first.offsetTop;
  const n = kids.findIndex((k) => k.offsetTop !== top);
  return Math.max(1, n === -1 ? kids.length : n);
}

// ---------- desktop status ----------

/**
 * The three numbers that say how far the tidying has got, over what is actually
 * on the desktop. 未分类 is the remainder, never a row in the zone count — it is
 * the name of not having a zone (see CONTEXT.md).
 */
function paintStatus(): void {
  // Over every launch target, hidden ones included: 未分类 is a fact about the
  // target, not about whether it is on screen, and the tidy this panel starts
  // will reach the hidden ones too. Counting only the visible ones would report
  // progress that hiding, not tidying, produced.
  const s = deskStats(all.map((t) => t.path), stored);

  statusWhenEl.textContent = sinceTidy(lastTidy, Date.now()) ?? "";
  // Each bar reads as bright as its row is large, against the largest of the
  // three — the design's way of showing the split without a chart.
  const rows = [
    ["已归入分区", s.zoned],
    ["未分类", s.unzoned],
    ["分区数量", s.zoneCount],
  ] as const;
  const largest = Math.max(1, ...rows.map(([, value]) => value));

  statusRowsEl.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "srow";

      const bar = document.createElement("div");
      bar.className = "sbar";
      bar.style.opacity = (0.4 + (value / largest) * 0.55).toFixed(2);

      const name = document.createElement("div");
      name.className = "slabel";
      name.textContent = label;

      const count = document.createElement("div");
      count.className = "svalue";
      count.textContent = String(value);

      row.append(bar, name, count);
      return row;
    }),
  );

  tidyUnzonedEl.textContent = `整理未分类的 ${s.unzoned} 项`;
  // With nothing left over there is nothing to start: a tidy here would spend a
  // model call to re-file what is already filed.
  // Disabled with no zones as well: with nothing to file into, 整理 becomes the
  // 分区建议 of ADR 0009 — a different act, and one the 整理 button owns.
  tidyUnzonedEl.disabled = s.unzoned === 0 || s.zoneCount === 0;
}

function paint(): void {
  paintTabs();
  paintGrid();
  paintStatus();
}

// ---------- search overlay ----------

function paintResults(): void {
  results = rank(all, queryEl.value.trim(), (t) => t.name).slice(0, MAX_RESULTS);
  pick = Math.min(pick, Math.max(0, results.length - 1));

  if (results.length === 0) {
    const none = document.createElement("div");
    none.id = "nores";
    none.textContent = "没有匹配的启动项";
    resultsEl.replaceChildren(none);
    return;
  }

  resultsEl.replaceChildren(
    ...results.map((t, i) => {
      const row = document.createElement("div");
      row.className = i === pick ? "res on" : "res";
      row.title = t.path;
      row.addEventListener("mouseenter", () => {
        pick = i;
        paintResults();
      });
      row.addEventListener("click", () => void run(t));

      const ico = document.createElement("div");
      ico.className = "resico";
      iconStyle(ico, t);

      const name = document.createElement("span");
      name.className = "resname";
      name.textContent = t.name;

      const src = document.createElement("span");
      src.className = "ressrc";
      // The rail row is tight, so only the two non-default provenances earn a
      // label there; 开始菜单 is what a target is unless told otherwise.
      src.textContent = t.source === "startmenu" ? "" : sourceName(t);

      row.append(ico, name, src);
      return row;
    }),
  );

  resultsEl.children[pick]?.scrollIntoView({ block: "nearest" });
}

// ---------- settings overlay ----------

type Settings = {
  /** Whether a key is stored. The key itself never leaves the backend. */
  hasKey: boolean;
  model: string;
  baseUrl: string;
  autostart: boolean;
  /** Whichever hotkey actually registered, or empty if none of them did. */
  hotkey: string;
};

const effectStateEl = el("seteffectstate");

/**
 * Which of the two glass paths is actually running, in words, where the person
 * judging the glass will see it.
 *
 * Losing the interface capture is the one failure here that looks like a design
 * choice: the glass keeps working and quietly refracts the wallpaper alone on a
 * lighter darkness ramp. Issue #4's acceptance run has to start by ruling that
 * out, and `window.__dmCapture` in devtools is a poor place to make somebody go
 * and look.
 */
function paintEffectState(): void {
  const bag = window as unknown as { __dmCapture?: string; __dmRenderer?: string };
  const capture = bag.__dmCapture;
  const renderer = bag.__dmRenderer ?? "未知";
  const live = capture !== undefined && capture !== "none";
  // Named only when it is the answer to something. Spelling out a working GPU
  // buries the sentence that matters under a driver string nobody needs to read.
  const gpu = isSoftware(renderer) ? `掉进软件渲染：${renderer}` : "";

  // Neither marker set means the background layer never got as far as looking.
  // Saying "the capture is missing" there would send the reader after the wrong
  // thing entirely.
  if (capture === undefined && bag.__dmRenderer === undefined) {
    effectStateEl.textContent = "背景层没有启动，这一档什么都没画。";
    effectStateEl.classList.add("degraded");
    return;
  }

  const glass = live
    ? `玻璃在折射界面（ctx.${capture}），压暗 0.16→0.54。可以按标准验。`
    : "玻璃只折射壁纸：界面捕获拿不到，压暗换成轻档 0.06→0.26。" +
      "这一轮不值得验——先查 WebView2 有没有带上 --enable-blink-features=CanvasDrawElement。";
  effectStateEl.textContent = gpu ? `${glass} 另外${gpu}` : glass;
  effectStateEl.classList.toggle("degraded", !live || gpu !== "");
}

const settingsEl = el("settings");
const keyEl = el<HTMLInputElement>("setkey");
const modelEl = el<HTMLInputElement>("setmodel");
const urlEl = el<HTMLInputElement>("seturl");
const autoEl = el("setauto");
const setMsgEl = el("setmsg");
const setZonesEl = el("setzones");
const hiddenRowEl = el("sethiddenrow");
const hiddenCountEl = el("sethiddencount");

let settingsOpen = false;

function settingsShowing(): boolean {
  return settingsOpen;
}

/**
 * Writes the zone set through and repaints. Every committed zone change goes
 * through here so disk, tab strip and rail can never disagree.
 *
 * Edits made in the settings panel do not call this directly — they mutate a
 * draft, and 保存 commits it. See `draft`.
 */
async function commitZones(next: StoredZone[]): Promise<void> {
  stored = next;
  try {
    await invoke("write_zones", { value: { zones: stored, pinned: [...pinned] } });
  } catch (err) {
    setMsgEl.textContent = String(err);
  }
  tile = 0;
  paint();
  // The settings rows render the draft, not `stored`, so they are only redrawn
  // when that panel actually owns a draft. The first-run review renders the live
  // set and does need redrawing.
  if (settingsOpen) paintZoneRows();
  if (firstOpen && step === 2) paintFirst();
}

/**
 * The settings panel's working copy. Zone edits land here and only reach disk on
 * 保存, matching how the key/model fields in the same panel behave — the panel
 * used to apply zone changes instantly while everything else waited for a button,
 * which is two contradictory models in one place.
 */
let draft: StoredZone[] = [];

function paintZoneRows(): void {
  setZonesEl.replaceChildren(
    ...zoneRowNodes(draft, (next) => {
      draft = next;
      paintZoneRows();
    }),
  );
}

/**
 * Editable zone rows over an arbitrary list. The settings panel passes its draft;
 * the first-run review passes the live set, because that screen has no 保存 of its
 * own — advancing past it is the commit.
 */
function zoneRowNodes(
  list: StoredZone[],
  onChange: (next: StoredZone[]) => void,
): HTMLElement[] {
  if (list.length === 0) {
    const none = document.createElement("div");
    none.className = "fhint";
    none.textContent = "还没有分区。点「整理」让 AI 提一套，或者自己新建。";
    return [none];
  }

  return list.map((z, i) => {
    const row = document.createElement("div");
    row.className = "zrow";
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", String(i));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer?.getData("text/plain"));
      if (Number.isNaN(from) || from === i) return;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(i, 0, moved);
      onChange(next);
    });

    const grip = document.createElement("span");
    grip.className = "zgrip";
    grip.textContent = "⠿";

    const name = document.createElement("input");
    name.className = "zname";
    name.value = z.name;
    const rename = () => {
      const value = name.value.trim();
      // An empty name would produce an unclickable tab, so refuse it by putting
      // the old one back rather than reporting an error.
      if (!value || value === z.name) {
        name.value = z.name;
        return;
      }
      onChange(list.map((other, j) => (j === i ? { ...other, name: value } : other)));
    };
    name.addEventListener("blur", rename);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") {
        name.value = z.name;
        name.blur();
      }
      e.stopPropagation();
    });

    const count = document.createElement("span");
    count.className = "zcount";
    count.textContent = `${z.items.length} 项`;

    const del = document.createElement("button");
    del.className = "zdel";
    del.textContent = "删除";
    del.addEventListener("click", () => onChange(list.filter((_, j) => j !== i)));

    row.append(grip, name, count, del);
    return row;
  });
}

function addZone(): void {
  const base = "新分区";
  let name = base;
  let n = 2;
  while (draft.some((z) => z.name === name)) name = `${base}${n++}`;
  draft = [...draft, { name, items: [] }];
  paintZoneRows();
}

/**
 * Moves one target into a zone, removing it from wherever it was. A `null` zone
 * takes it out of every zone, leaving it visible only under 全部.
 */
function moveTo(target: LaunchTarget, zoneName: string | null): void {
  void commitZones(
    stored.map((z) => ({
      name: z.name,
      items:
        z.name === zoneName
          ? [...z.items.filter((p) => p !== target.path), target.path].sort()
          : z.items.filter((p) => p !== target.path),
    })),
  );
}

function zoneOf(target: LaunchTarget): string | null {
  return stored.find((z) => z.items.includes(target.path))?.name ?? null;
}

function togglePin(target: LaunchTarget): void {
  if (pinned.has(target.path)) pinned.delete(target.path);
  else pinned.add(target.path);
  // Pins live in the same document as the zones, so this writes both.
  void commitZones(stored);
}

/**
 * The bulk way back: one row, only when there is something to restore. Hiding one
 * target does not deserve a permanent settings section, and an always-visible
 * "已隐藏 0 项" would be a row about nothing.
 */
function paintHiddenRow(): void {
  hiddenRowEl.classList.toggle("hide", hiddenPaths.size === 0);
  hiddenCountEl.textContent = `已隐藏 ${hiddenPaths.size} 项`;
}

async function openSettings(): Promise<void> {
  const s = await invoke<Settings>("read_settings");
  // The backend only reports whether a key exists. An empty field means "leave it
  // alone", so the placeholder is the only thing that reveals the state.
  keyEl.value = "";
  keyEl.placeholder = s.hasKey ? "已存入凭据管理器，留空则不修改" : "粘贴 API key";
  modelEl.value = s.model;
  urlEl.value = s.baseUrl;
  autoEl.classList.toggle("on", s.autostart);
  // Reported rather than hardcoded: printing a fixed string here is how the
  // panel came to advertise a hotkey nothing had registered.
  el("sethotkey").textContent = s.hotkey || "全部被占用，没能注册";
  paintEffectState();
  setMsgEl.textContent = "";
  // Opening a panel of ours is proof somebody is looking, so the scene must not
  // stay parked waiting for the next occlusion poll — that was the several
  // seconds of lag before a change showed up.
  background?.wake();
  // Deep copy, so discarding really discards.
  draft = stored.map((z) => ({ name: z.name, items: [...z.items] }));
  paintZoneRows();
  paintHiddenRow();

  settingsOpen = true;
  scrimEl.classList.remove("hide");
  settingsEl.classList.remove("hide");
  (s.hasKey ? modelEl : keyEl).focus();
  refreshGlass();
}

/** Closing without saving throws the draft away — that is what makes it a draft. */
function closeSettings(): void {
  settingsOpen = false;
  draft = [];
  settingsEl.classList.add("hide");
  scrimEl.classList.add("hide");
  refreshGlass();
}

async function saveSettings(): Promise<void> {
  try {
    await invoke("write_settings", {
      apiKey: keyEl.value,
      model: modelEl.value,
      baseUrl: urlEl.value,
      autostartOn: autoEl.classList.contains("on"),
    });
    await commitZones(draft);
    closeSettings();
    toast("设置已保存");
  } catch (err) {
    setMsgEl.textContent = String(err);
  }
}

function openSearch(seed = ""): void {
  searchOpen = true;
  queryEl.value = seed;
  pick = 0;
  scrimEl.classList.remove("hide");
  searchEl.classList.remove("hide");
  paintResults();
  // WS_EX_NOACTIVATE means a click never brought the keyboard with it, so the
  // surface has to ask for it before a DOM focus() can mean anything.
  void invoke("grab_focus");
  queryEl.focus();
  // Straight away: panels fade in without moving, so the rectangle is already
  // its resting position on the first frame.
  refreshGlass();
}

function closeSearch(): void {
  searchOpen = false;
  scrimEl.classList.add("hide");
  searchEl.classList.add("hide");
  refreshGlass();
}

// ---------- actions ----------

async function revealIn(target: LaunchTarget): Promise<void> {
  try {
    await invoke("reveal", { path: target.path });
  } catch (err) {
    // Worth a toast rather than only the console: the usual failure is a
    // shortcut pointing at something that has since been uninstalled, and
    // nothing visible happening looks like a broken menu item.
    toast("打开文件位置失败", String(err));
  }
}

async function copyPath(target: LaunchTarget): Promise<void> {
  try {
    await navigator.clipboard.writeText(target.path);
  } catch (err) {
    console.error("复制路径失败", err);
  }
}

/**
 * One ring where the launch came from. Drawn on the stage rather than in the
 * grid so it is not clipped by the scroll, and thrown away the moment it has
 * played — whatever was just started is about to cover the desktop anyway.
 *
 * A search result has no tile on screen, so it gets no ring.
 */
function burstAt(target: LaunchTarget): void {
  if (reduced.matches) return;
  const node = tileNodes().find((n) => n.dataset.path === target.path);
  if (!node) return;
  const box = node.getBoundingClientRect();
  const ring = document.createElement("div");
  ring.className = "burst";
  ring.style.left = `${box.left + box.width / 2}px`;
  ring.style.top = `${box.top + box.height / 2}px`;
  ring.addEventListener("animationend", () => ring.remove());
  // Deliberately not cut short when the launched app takes the foreground. That
  // blur lands within a frame or two of the click, so removing the ring on it
  // deleted the ring every single time — the acknowledgement never survived long
  // enough to be an acknowledgement. ADR 0016's line is about what a covered
  // desktop draws while it sits there, not about a one-second answer to a click
  // that was made while the desktop was in front of the user.
  stageEl.append(ring);
}

async function run(target: LaunchTarget): Promise<void> {
  burstAt(target);
  // Nothing to get out of the way: we are the desktop, so the launched app opens
  // on top of us the way it would over any desktop.
  try {
    await invoke("launch", { path: target.path });
  } catch (err) {
    console.error("启动失败", target.path, err);
  }
}

/** Arrow keys over the grid. Reading order sideways, a whole row up and down. */
function moveTile(key: ArrowKey): void {
  const items = inZone();
  if (items.length === 0) return;
  tile = moveInGrid(tile, items.length, cols, key);
  paintGrid();
}

function moveZone(delta: number): void {
  const count = tabNames().length;
  zone = (zone + delta + count) % count;
  tile = 0;
  paint();
}

// ---------- toast ----------

let toastTimer = 0;

function toast(
  title: string,
  sub = "",
  action?: { label: string; act: () => void },
): void {
  toastTitleEl.textContent = title;
  toastSubEl.textContent = sub;
  if (action) {
    toastActEl.textContent = action.label;
    toastActEl.classList.remove("hide");
    toastActEl.onclick = () => {
      hideToast();
      action.act();
    };
  } else {
    toastActEl.classList.add("hide");
    toastActEl.onclick = null;
  }
  toastEl.classList.remove("hide");

  window.clearTimeout(toastTimer);
  // Undo needs long enough to notice and reach; plain confirmations do not.
  toastTimer = window.setTimeout(hideToast, action ? 9000 : 4000);
}

function hideToast(): void {
  toastEl.classList.add("hide");
}

// ---------- tidy ----------

async function loadZones(): Promise<void> {
  const value = await invoke<Zones>("read_zones");
  stored = value.zones;
  pinned = new Set(value.pinned ?? []);
  hiddenPaths = new Set(value.hidden ?? []);
}

/**
 * Writes a new hidden list through and repaints. Every change to what is hidden
 * goes through here, so disk and grid can never disagree.
 */
async function setHidden(next: Set<string>, failure: string): Promise<boolean> {
  try {
    await invoke("write_hidden", { paths: [...next] });
  } catch (err) {
    toast(failure, String(err));
    return false;
  }
  hiddenPaths = next;
  paint();
  if (settingsOpen) paintHiddenRow();
  return true;
}

/**
 * Takes a launch target off the grid — every tab of it, 全部 included.
 *
 * Not a removal: the target still exists, search still finds it, and its file is
 * untouched (ADR 0004). Search is the recovery path a user reaches for first,
 * which is why the toast says so; 设置 carries the bulk one.
 */
async function hideTarget(t: LaunchTarget): Promise<void> {
  const next = new Set(hiddenPaths);
  next.add(t.path);
  if (!(await setHidden(next, "隐藏失败"))) return;
  toast(`已隐藏「${t.name}」`, "搜索还能找到它，设置里可以全部恢复", {
    label: "撤销",
    act: () => {
      const back = new Set(hiddenPaths);
      back.delete(t.path);
      void setHidden(back, "恢复失败");
    },
  });
}

async function undoTidy(): Promise<void> {
  if (!previous) return;
  const restore = previous;
  previous = null;
  scatterTiles();
  try {
    await Promise.all([invoke("write_zones", { value: restore }), scatterHold()]);
    stored = restore.zones;
    pinned = new Set(restore.pinned);
    tile = 0;
    paint();
  } catch (err) {
    toast("撤销失败", String(err));
    return;
  } finally {
    // Undo travels the same path out and back as the tidy it is reversing.
    settleTiles();
  }
  toast("已恢复整理前的分区");
}

async function doTidy(unzonedOnly = false): Promise<void> {
  const check = await invoke<{ ready: boolean; configPath: string }>("status");
  if (!check.ready) {
    toast("还没有填 API key", "在设置里填一次就好", {
      label: "打开设置",
      act: () => void openSettings(),
    });
    return;
  }

  const first = stored.length === 0;
  previous = {
    zones: stored.map((z) => ({ name: z.name, items: [...z.items] })),
    pinned: [...pinned],
  };

  tidyBtn.disabled = true;
  tidyBtn.textContent = "整理中…";
  toast(first ? "正在读桌面，判断该分成哪些区" : "正在整理");
  scatterTiles();

  try {
    const [result] = await Promise.all([
      invoke<Zones>("run_tidy", { unzonedOnly }),
      scatterHold(),
    ]);
    stored = result.zones;
    pinned = new Set(result.pinned ?? []);
    // The backend has just written the same stamp to disk; taking it locally
    // saves a round trip and keeps the panel honest until the next restart.
    lastTidy = Date.now();
    zone = 0;
    tile = 0;
    paint();

    const placed = result.zones.reduce((n, z) => n + z.items.length, 0);
    const missed = all.length - placed;
    toast(
      first ? `建了 ${result.zones.length} 个分区` : `已整理 ${placed} 项`,
      missed > 0 ? `${missed} 项没能归类，留在原处` : result.zones.map((z) => z.name).join(" · "),
      first ? undefined : { label: "撤销", act: () => void undoTidy() },
    );
  } catch (err) {
    previous = null;
    toast("整理失败", String(err));
  } finally {
    // Every ending lands the field, the failed one included: tiles left mid-air
    // would say the tidy is still running long after it gave up.
    settleTiles();
    tidyBtn.disabled = false;
    tidyBtn.textContent = "整理";
  }
}

// ---------- keyboard ----------

window.addEventListener("keydown", (e) => {
  // Right-click is swallowed to keep the browser menu away, so this is the way
  // into the inspector.
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "i") {
    e.preventDefault();
    void invoke("open_devtools");
    return;
  }

  // The first-run flow owns the keyboard while it is up. It is dismissed with
  // 跳过 or 开始用, never by Esc — leaving it half-done would hide the only
  // explanation the app ever offers.
  if (firstOpen) {
    if (e.key === "Enter") void nextStep();
    return;
  }

  const ctxOpen = !ctxEl.classList.contains("hide");
  if (e.key === "Escape") {
    if (ctxOpen) closeCtx();
    else if (settingsShowing()) closeSettings();
    else if (searchOpen) closeSearch();
    // Nothing left to dismiss to — Esc on the bare desktop does nothing, the
    // same as it does on the real one.
    return;
  }
  if (ctxOpen) closeCtx();

  if (settingsShowing()) {
    // Enter saves; everything else belongs to whichever field has focus.
    if (e.key === "Enter") void saveSettings();
    return;
  }

  if (searchOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) {
        pick = (pick + 1) % results.length;
        paintResults();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) {
        pick = (pick - 1 + results.length) % results.length;
        paintResults();
      }
    } else if (e.key === "Enter") {
      const target = results[pick];
      if (target) void run(target);
    }
    return;
  }

  switch (e.key) {
    case "ArrowRight":
    case "ArrowLeft":
    case "ArrowUp":
    case "ArrowDown":
      e.preventDefault();
      moveTile(e.key);
      return;
    case "Tab":
      e.preventDefault();
      moveZone(e.shiftKey ? -1 : 1);
      return;
    case "Enter": {
      const target = inZone()[tile];
      if (target) void run(target);
      return;
    }
  }

  // Any printable character starts a search — the launcher reflex.
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openSearch(e.key);
  }
});

// The grid is `auto-fill`, so a resized window silently changes the column count
// under the keyboard. Re-measuring is cheaper than repainting every tile, and
// the glow has to follow the tile to wherever the new columns put it.
window.addEventListener("resize", () => {
  cols = measureCols();
  publishTileWidth();
  paintGlow();
});

// Only the selected tile leans, and only under a pointer. An arrow key has no
// position to lean by, so a keyboard selection lands flat — and a tile that kept
// its tilt after the pointer had gone would read as picked up, not as selected.
gridEl.addEventListener("pointermove", (e) => leanAt(e.clientX, e.clientY));
gridEl.addEventListener("pointerleave", () => setTilt(null));

// The glass lights from wherever the pointer is. Cheap — it stores two numbers
// that the running loop reads — and deliberately not a reason to start drawing:
// a pointer crossing a covered desktop still draws nothing.
window.addEventListener("pointermove", (e) => {
  background?.setLight({ x: e.clientX, y: e.clientY });
});

queryEl.addEventListener("input", () => {
  pick = 0;
  paintResults();
});

el("searchbtn").addEventListener("click", () => openSearch());
tidyBtn.addEventListener("click", () => void doTidy());
el("setbtn").addEventListener("click", () => void openSettings());
el("setsave").addEventListener("click", () => void saveSettings());
el("setcancel").addEventListener("click", closeSettings);
autoEl.addEventListener("click", () => autoEl.classList.toggle("on"));
el("addzone").addEventListener("click", addZone);
el("sethiddenrestore").addEventListener("click", () => void setHidden(new Set(), "恢复失败"));
tidyUnzonedEl.addEventListener("click", () => void doTidy(true));

// One scrim serves the overlays, so it dismisses whichever is up — except the
// first-run flow, which has its own exits.
scrimEl.addEventListener("click", () => {
  if (firstOpen) return;
  if (settingsShowing()) closeSettings();
  else closeSearch();
});

el("open").addEventListener("click", () => {
  const t = selected();
  if (t) void run(t);
});
el("more").addEventListener("click", (e) => {
  const t = selected();
  if (!t) return;
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openCtx(t, box.left, box.bottom + 8);
});

// Any click that is not inside the menu dismisses it, including on a tile.
window.addEventListener("mousedown", (e) => {
  const inMenu = ctxEl.contains(e.target as Node);
  if (!inMenu) closeCtx();

});
// The browser menu never helps here, so it always goes. Bare stage gets the
// stand-in for the desktop menu it is covering; anything with its own handler
// (tiles) or its own affordances (panels, controls) is left alone.
//
// Desktop surface only. The launchpad covers nothing — Esc puts the real
// desktop back — so there is nothing there for a stand-in to stand in for.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const onControl = (e.target as HTMLElement).closest(
    ".tile, .tab, .pill, .panel, #hero, #status, #ctx, .resrow, button, input",
  );
  if (!onControl) openStageMenu(e.clientX, e.clientY);
});
// ---------- lifecycle ----------

function tickClock(): void {
  // The status panel's "上次整理 X 前" ages on its own, so it rides the clock
  // rather than waiting for the next repaint to notice.
  statusWhenEl.textContent = sinceTidy(lastTidy, Date.now()) ?? "";
  const now = new Date();
  clockEl.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
}


type Theme = { path: string | null; accent: string; brightness: number };

/** Last wallpaper we painted, so a re-read that changed nothing does no work. */
let themePath: string | null = null;
let background: Scene | null = null;

/**
 * Hands every open panel's rectangle to the shader so it can bend the wallpaper
 * behind them, and thins their own backgrounds out of the way — the darkening
 * that keeps text legible now happens inside the glass.
 *
 * Takes whatever is on screen rather than one named element: the settings panel,
 * a context menu and the search overlay can be up together, and glass on only one
 * of them looks worse than glass on none.
 */
function refreshGlass(): void {
  if (!background) return;

  const panels = [searchEl, settingsEl, ctxEl, firstEl].filter(
    (p) => !p.classList.contains("hide"),
  );

  background.setGlass(
    panels.map((p) => {
      p.classList.add("glassed");
      // Measured after the class lands and after the entry animation settles —
      // reading mid-animation gives a rectangle a few pixels off from where the
      // panel comes to rest, which shows as a second frame outside the border.
      const box = p.getBoundingClientRect();
      return {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        radius: parseFloat(getComputedStyle(p).borderTopLeftRadius) || 20,
      };
    }),
  );
}

/**
 * Veil strength from wallpaper brightness. A dark photo needs little help; a
 * bright one needs a lot before white text holds up. Clamped so the wallpaper
 * never disappears entirely and never shows through enough to fight the text.
 *
 * Applied to a vertical gradient rather than a flat wash — the design darkens the
 * top and bottom and lets the middle breathe, which reads as depth instead of as
 * a grey sheet laid over the picture.
 */
function veilFor(brightness: number): string {
  const dim = Math.min(0.66, Math.max(0.26, 0.2 + brightness * 0.52));
  const at = (extra: number) => `rgba(6, 7, 11, ${(dim + extra).toFixed(2)})`;
  return `linear-gradient(180deg, ${at(0.14)} 0%, ${at(-0.06)} 36%, ${at(0.2)} 100%)`;
}

async function loadTheme(): Promise<void> {
  try {
    const t = await invoke<Theme>("read_theme");
    if (t.path === themePath) return;
    themePath = t.path;

    // Straight at the original file through the asset protocol: full resolution,
    // no re-encode, and the browser caches the decode for us.
    const url = t.path ? convertFileSrc(t.path) : "";
    el("wall").style.backgroundImage = url ? `url("${url}")` : "";
    if (url) background?.setWallpaper(url);
    // One variable drives every accent in the sheet — blooms, tabs, buttons,
    // switches, the pin dot — so the whole interface retints from the wallpaper
    // in one assignment.
    document.documentElement.style.setProperty("--accent", t.accent);
    // The CSS veil is the fallback; when the shader is running it draws its own,
    // inside the scene, so that the glass refracts it too.
    el("veil").style.background = veilFor(t.brightness);
    background?.setAccent(t.accent);
    background?.setVeil(t.brightness);
  } catch (err) {
    console.error("读壁纸失败", err);
  }
}

async function loadIcons(): Promise<void> {
  try {
    const map = await invoke<Record<string, string>>("icons", {
      paths: all.map((t) => t.path),
    });
    iconOf = new Map(Object.entries(map));
    paint();
    if (searchOpen) paintResults();
  } catch (err) {
    console.error("图标提取失败", err);
  }
}

// ---------- first run ----------

const firstEl = el("first");
const fTitleEl = el("ftitle");
const fBodyEl = el("fbody");
const fContentEl = el("fcontent");
const fStepEl = el("fstep");
const fNextEl = el<HTMLButtonElement>("fnext");
const fSkipEl = el("fskip");
const fErrEl = el("ferr");

let step = 0;
let firstOpen = false;

const STEPS = 4;

function paintFirst(): void {
  el("fdots")
    .querySelectorAll(".fdot")
    .forEach((d, i) => d.classList.toggle("on", i <= step));
  fStepEl.textContent = `第 ${step + 1} / ${STEPS} 步`;
  fErrEl.textContent = "";
  fContentEl.replaceChildren();
  fSkipEl.classList.toggle("hide", step === STEPS - 1);
  fNextEl.disabled = false;

  if (step === 0) {
    fTitleEl.textContent = "先给 deskmind 一把钥匙";
    fBodyEl.textContent =
      "整理需要一个大模型来判断每个程序是干什么的。填入你自己的 API key，请求直接从这台电脑发给模型厂商，不经过任何中间服务器。";
    const input = document.createElement("input");
    input.className = "finput";
    input.type = "password";
    input.placeholder = "粘贴 API key";
    input.id = "fkey";
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void nextStep();
    });
    const hint = document.createElement("div");
    hint.className = "fhint";
    hint.textContent =
      "默认用 DeepSeek。想换别的 OpenAI 兼容服务，之后在设置里改模型和接口地址。";
    fContentEl.append(input, hint);
    fNextEl.textContent = "下一步";
    setTimeout(() => input.focus(), 0);
    return;
  }

  if (step === 1) {
    fTitleEl.textContent = "正在看你装了些什么";
    fBodyEl.textContent = `读到 ${all.length} 个启动项，正在判断该分成哪些区。`;
    const bar = document.createElement("div");
    bar.id = "fbar";
    const fill = document.createElement("div");
    fill.id = "fbarfill";
    bar.append(fill);
    fContentEl.append(bar);
    fNextEl.textContent = "请稍候";
    fNextEl.disabled = true;
    return;
  }

  if (step === 2) {
    fTitleEl.textContent = "这样分行吗";
    fBodyEl.textContent =
      "这是建议，不是决定。名字可以改，多余的可以删——分区是你的，之后每次整理 AI 只会往这些分区里放东西，不会自己新建。";
    fContentEl.append(...zoneRowNodes(stored, (next) => void commitZones(next)));
    fNextEl.textContent = "就这样";
    return;
  }

  fTitleEl.textContent = "可以用了";
  fBodyEl.textContent =
    "按 Alt + Space 随时唤出。直接打字搜索，回车打开。装了新程序就再点一次「整理」。";
  fNextEl.textContent = "开始用";
}

async function nextStep(): Promise<void> {
  fErrEl.textContent = "";

  if (step === 0) {
    const key = (document.getElementById("fkey") as HTMLInputElement | null)?.value ?? "";
    if (!key.trim()) {
      fErrEl.textContent = "还没填 key。也可以点「跳过」，之后在设置里补。";
      return;
    }
    try {
      await invoke("write_settings", {
        apiKey: key,
        model: "",
        baseUrl: "",
        autostartOn: true,
      });
    } catch (err) {
      fErrEl.textContent = String(err);
      return;
    }
    step = 1;
    paintFirst();
    // The suggestion runs while step 1 is on screen; its outcome decides whether
    // we advance to the review step or fall back to it empty.
    try {
      // First run has no zones yet, so this is the 分区建议 over everything.
      const result = await invoke<Zones>("run_tidy", { unzonedOnly: false });
      stored = result.zones;
      paint();
    } catch (err) {
      step = 0;
      paintFirst();
      fErrEl.textContent = String(err);
      return;
    }
    step = 2;
    paintFirst();
    return;
  }

  if (step === 1) return;

  if (step === 2) {
    step = 3;
    paintFirst();
    return;
  }

  await closeFirst();
}

async function closeFirst(): Promise<void> {
  firstOpen = false;
  firstEl.classList.add("hide");
  scrimEl.classList.add("hide");
  try {
    await invoke("finish_onboarding");
  } catch (err) {
    console.error("标记首次运行完成失败", err);
  }
}

function openFirst(): void {
  firstOpen = true;
  step = 0;
  scrimEl.classList.remove("hide");
  firstEl.classList.remove("hide");
  paintFirst();
}

fNextEl.addEventListener("click", () => void nextStep());
fSkipEl.addEventListener("click", () => void closeFirst());

/**
 * A file dragged in from Explorer becomes a launch target, and nothing else.
 *
 * The other reading — "file it into this zone" — is a file operation wearing an
 * organisation costume, and ADR 0004 says deskmind never moves, renames or
 * deletes a user's files. So the drop records a path. The file stays where the
 * user put it.
 *
 * Dropping while a zone tab is open also places the new targets in that zone,
 * which is the only reason to have that tab open while dragging. That is a
 * membership change, not a file one.
 */
async function addTargets(paths: string[]): Promise<void> {
  const before = new Set(all.map((t) => t.path));
  try {
    all = await invoke<LaunchTarget[]>("add_targets", { paths });
  } catch (err) {
    toast("添加启动项失败", String(err));
    return;
  }

  // What actually landed, not what was dropped: paths already known and paths
  // that no longer resolve never become targets.
  const fresh = all.filter((t) => !before.has(t.path));
  paint();
  if (fresh.length === 0) {
    toast("这些启动项已经在了");
    return;
  }

  // Deliberately not filed into the open zone: adding and filing are separate
  // decisions, and the tab that happens to be open is a weak guess at the second
  // one. Dragging the new tile onto a zone tab already does that, explicitly.
  toast(`已添加 ${fresh.length} 个启动项`, "只记路径，文件没有移动", {
    label: "撤销",
    act: () => void Promise.all(fresh.map((t) => removeTarget(t))),
  });
  void loadIcons();
}

/** Forgets a dropped-in target. The file it points at is left alone. */
async function removeTarget(t: LaunchTarget): Promise<void> {
  try {
    all = await invoke<LaunchTarget[]>("remove_target", { path: t.path });
  } catch (err) {
    toast("移除失败", String(err));
    return;
  }
  pinned.delete(t.path);
  await loadZones();
  paint();
}

async function load(): Promise<void> {
  tickClock();
  setInterval(tickClock, 20_000);
  try {
    // Both surfaces. The search panel — the one the glass is built for — is seen
    // far more often on the launchpad than on the desktop, and a hidden window
    // is not painted, so the launchpad's loop costs nothing while it is away.
    background = startBackground(true);
    void loadTheme();

    all = await invoke<LaunchTarget[]>("list_targets");
    await loadZones();
    paint();
    void loadIcons();
    // The summon hotkey, registered in Rust. It has already taken the keyboard
    // for us by the time this arrives, so there is nothing to do but open.
    void listen("dm://summon", () => {
      if (firstOpen) return;
      background?.wake();
      openSearch();
    });
    void win.onDragDropEvent((e) => {
      if (e.payload.type === "drop" && e.payload.paths.length > 0) {
        void addTargets(e.payload.paths);
      }
    });

    const s = await invoke<{ onboarded: boolean; lastTidy: number }>("status");
    lastTidy = s.lastTidy;
    paintStatus();
    if (!s.onboarded) {
      openFirst();
      // First run is the one moment the surface needs the keyboard before the
      // user has clicked anything.
      void invoke("grab_focus");
    }
  } catch (err) {
    summaryEl.textContent = "扫描失败";
    console.error(err);
  }
}

void load();
