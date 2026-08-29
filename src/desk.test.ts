import { expect, test } from "bun:test";
import { deskStats, moveInGrid, sinceTidy } from "./desk";

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
