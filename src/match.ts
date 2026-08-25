/**
 * Launcher-style matching: substring first, subsequence as a fallback, so that
 * "vsc" finds "Visual Studio Code" without an index or a fuzzy library.
 *
 * Returns null when the query does not match at all. Higher is better.
 *
 * Chinese names only match on the characters themselves — typing "wx" will not
 * find 微信. Pinyin-initial matching needs a character table and is deferred
 * until the launcher is otherwise usable.
 */
export function score(name: string, query: string): number | null {
  if (!query) return 0;

  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();

  const at = haystack.indexOf(needle);
  if (at >= 0) {
    // Earlier is better, and among equal positions the shorter name wins —
    // "Word" should outrank "Microsoft Word Viewer Compatibility Pack".
    return 1000 - at * 4 - name.length * 0.2;
  }

  // Subsequence: every query character in order, gaps allowed but penalised.
  let cursor = 0;
  let previous = -1;
  let gaps = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, cursor);
    if (found < 0) return null;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    cursor = found + 1;
  }
  return 500 - gaps * 3 - name.length * 0.2;
}

/** Filters and orders by score, keeping the original order as the tiebreak. */
export function rank<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query) return items;
  return items
    .map((item, index) => ({ item, index, s: score(key(item), query) }))
    .filter((r): r is { item: T; index: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((r) => r.item);
}
