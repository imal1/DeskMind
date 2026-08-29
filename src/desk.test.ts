import { expect, test } from "bun:test";
import { deskStats, moveInGrid, scatterAt, sinceTidy, tiltAt } from "./desk";

// ---------- grid navigation ----------

test("← → walk in reading order and run on across rows", () => {
  expect(moveInGrid(3, 10, 4, "ArrowRight")).toBe(4);
  expect(moveInGrid(4, 10, 4, "ArrowLeft")).toBe(3);
});

test("↑ ↓ jump a whole row", () => {
  expect(moveInGrid(1, 10, 4, "ArrowDown")).toBe(5);
  expect(moveInGrid(5, 10, 4, "ArrowUp")).toBe(1);
});

test("both axes clamp at the ends instead of wrapping", () => {
  expect(moveInGrid(0, 10, 4, "ArrowLeft")).toBe(0);
  expect(moveInGrid(9, 10, 4, "ArrowRight")).toBe(9);
  // A row jump off the top or bottom lands on the nearest tile rather than
  // stopping dead, which is what the design mock does.
  expect(moveInGrid(1, 10, 4, "ArrowUp")).toBe(0);
  expect(moveInGrid(9, 10, 4, "ArrowDown")).toBe(9);
});

test("an empty grid stays at zero", () => {
  expect(moveInGrid(0, 0, 4, "ArrowRight")).toBe(0);
});

// ---------- desktop status ----------

const zones = [
  { name: "开发", items: ["a", "b"] },
  { name: "游戏", items: ["c"] },
];

test("counts what is filed and what is not", () => {
  const s = deskStats(["a", "b", "c", "d", "e"], zones);
  expect(s.zoned).toBe(3);
  expect(s.unzoned).toBe(2);
});

test("未分类 is not a zone, so it never inflates the zone count", () => {
  expect(deskStats(["a", "d"], zones).zoneCount).toBe(2);
  expect(deskStats(["d", "e"], zones).zoneCount).toBe(2);
});

test("a zone member that is no longer a launch target is not counted", () => {
  expect(deskStats(["a"], zones).zoned).toBe(1);
});

// ---------- last tidy ----------

const MIN = 60_000;

test("never tidied reads as no time at all", () => {
  expect(sinceTidy(0, 5 * MIN)).toBe(null);
});

test("a fresh tidy reads as just now", () => {
  expect(sinceTidy(5 * MIN, 5 * MIN + 3_000)).toBe("刚刚整理过");
});

test("older tidies read in the largest unit that fits", () => {
  expect(sinceTidy(0 + MIN, 40 * MIN)).toBe("上次整理 39 分钟前");
  expect(sinceTidy(MIN, MIN + 3 * 60 * MIN)).toBe("上次整理 3 小时前");
  expect(sinceTidy(MIN, MIN + 50 * 60 * MIN)).toBe("上次整理 2 天前");
});

test("a clock that went backwards still reads as just now", () => {
  expect(sinceTidy(10 * MIN, 9 * MIN)).toBe("刚刚整理过");
});

// ---------- motion ----------

test("the scatter pattern is the one the design fixed", () => {
  // ((i%5-2) × 26px, (i%3-1) × 20px), staggered (i%12) × 26ms.
  expect(scatterAt(0)).toEqual({ x: -52, y: -20, delay: 0 });
  expect(scatterAt(1)).toEqual({ x: -26, y: 0, delay: 26 });
  expect(scatterAt(4)).toEqual({ x: 52, y: 0, delay: 104 });
});

test("the pattern repeats rather than running away", () => {
  // Every factor is a remainder, so tile 60 sits exactly where tile 0 does and a
  // grid of any size scatters by the same fixed amount.
  expect(scatterAt(60)).toEqual(scatterAt(0));
});

test("the design's formula leaves one tile in fifteen standing still", () => {
  // i%5 === 2 zeroes x and i%3 === 1 zeroes y, which coincide every 15 tiles.
  // Recorded rather than corrected: the offsets are the design's, and a couple
  // of tiles holding their ground is what it asked for.
  expect(scatterAt(7)).toEqual({ x: 0, y: 0, delay: 182 });
  expect(scatterAt(22)).toEqual({ x: 0, y: 0, delay: 260 });
});

test("the tilt runs from -0.5 at one edge to 0.5 at the other", () => {
  expect(tiltAt(100, 100, 200)).toBe(-0.5);
  expect(tiltAt(200, 100, 200)).toBe(0);
  expect(tiltAt(300, 100, 200)).toBe(0.5);
});

test("a tile with no width does not tilt at all", () => {
  expect(tiltAt(100, 100, 0)).toBe(0);
});
