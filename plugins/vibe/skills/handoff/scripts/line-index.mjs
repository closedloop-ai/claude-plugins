// Line numbers for offsets in one text. The newline offsets are found once, then each lookup is a binary
// search, so a file with many matches costs one pass instead of one split of its whole prefix per match.

/**
 * A function from a 0-based offset in `text` to its 1-based line number, the same value as
 * `text.slice(0, offset).split("\n").length` for any offset from 0 up.
 */
export function lineIndex(text) {
  const newlines = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines.push(index);
  return (offset) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}
