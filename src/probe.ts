/**
 * S5 spike — is the HTML-in-Canvas API reachable inside WebView2?
 *
 * `drawElement` is an origin-trial API (Chrome 148–150) gated behind a flag. We
 * ship a desktop app with an embedded engine, so we can pass the flag ourselves
 * via `additionalBrowserArgs` — the question is whether WebView2 honours it, and
 * whether this machine's Chromium is new enough at all.
 *
 * ADR 0016 keeps this detection permanently, not just for the spike: the origin
 * trial expires, and when it does the method should quietly disappear and the
 * glass should fall back to `backdrop-filter` rather than the interface breaking.
 */

export type DrawElementProbe = {
  chromium: string;
  /** The method name that exists, if any — the proposal has used more than one. */
  method: string | null;
  available: boolean;
  summary: string;
};

// Both spellings seen in the proposal and its docs.
const CANDIDATES = ["drawElement", "drawElementImage"] as const;

/**
 * Paints the result into a corner panel that stays put. A toast was the first
 * attempt and got missed in the noise of startup — a spike's answer has to
 * survive being looked at a minute later.
 */
export function showProbePanel(probe: DrawElementProbe): void {
  const stage = document.getElementById("stage");
  if (!stage) return;

  const box = document.createElement("div");
  box.style.cssText =
    "position:absolute;right:16px;top:16px;z-index:40;padding:12px 14px;border-radius:12px;" +
    "background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.16);" +
    "font:11px/1.7 ui-monospace,Consolas,monospace;color:#fff;white-space:pre";
  box.textContent = [
    `S5  drawElement ${probe.available ? "✓ 可用" : "✗ 不可用"}`,
    `Chromium ${probe.chromium}`,
    `方法名 ${probe.method ?? "两个候选都不存在"}`,
    "",
    "点这里关掉",
  ].join("\n");
  box.addEventListener("click", () => box.remove());
  stage.appendChild(box);
}

export function probeDrawElement(): DrawElementProbe {
  const chromium = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "未知";

  const ctx = document.createElement("canvas").getContext("2d");
  const found = ctx
    ? CANDIDATES.find((name) => typeof (ctx as unknown as Record<string, unknown>)[name] === "function")
    : undefined;

  const method = found ?? null;
  return {
    chromium,
    method,
    available: method !== null,
    summary: method
      ? `Chromium ${chromium} · ${method}() 可用`
      : `Chromium ${chromium} · drawElement 不可用`,
  };
}
