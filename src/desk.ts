/**
 * The arithmetic behind the desktop grid and its status panel, kept out of
 * `main.ts` so it can be checked without a DOM.
 */

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/**
 * Where an arrow key lands in a grid of `count` tiles laid out `cols` wide.
 *
 * Left and right walk the reading order, so the end of a row runs on into the
 * start of the next one; up and down jump a whole row. Neither wraps around at
 * the first or last tile — the rail did, because it was one endless line, but a
 * grid has corners, and jumping from the last tile back to the first reads as
 * landing somewhere else on screen rather than as a step.
 */
export function moveInGrid(
  index: number,
  count: number,
  cols: number,
  key: ArrowKey,
): number {
  if (count <= 0) return 0;
  const width = Math.max(1, cols);
  const delta =
    key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? width : -width;
  return Math.min(count - 1, Math.max(0, index + delta));
}

export type ZoneLike = { name: string; items: string[] };

/**
 * How far the tidying has got: how many of the visible launch targets are filed,
 * how many are not, and how many zones there are.
 *
 * 未分类 is the absence of a zone, not a zone (see CONTEXT.md), so it is counted
 * as a remainder and never added to `zoneCount`.
 */
export function deskStats(
  paths: string[],
  zones: ZoneLike[],
): { zoned: number; unzoned: number; zoneCount: number } {
  const filed = new Set(zones.flatMap((z) => z.items));
  // Counted over the targets that exist, not over the zone lists: a zone can
  // still name a path whose program has since been uninstalled.
  const zoned = paths.filter((p) => filed.has(p)).length;
  return { zoned, unzoned: paths.length - zoned, zoneCount: zones.length };
}

/**
 * "上次整理 X 前", or null when there has never been one — a fresh install has
 * no time to show, and "上次整理 0 分钟前" would be a lie about a tidy that
 * never happened.
 */
export function sinceTidy(last: number, now: number): string | null {
  if (!last) return null;
  const minutes = Math.floor((now - last) / 60_000);
  if (minutes < 1) return "刚刚整理过";
  if (minutes < 60) return `上次整理 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `上次整理 ${hours} 小时前`;
  return `上次整理 ${Math.floor(hours / 24)} 天前`;
}
