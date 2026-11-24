import { fencedLineRanges } from "../lib/vibe/scripts/markdown-blocks.mjs";

/** Yield indexed original lines outside fenced examples. The tokenizer supplies half-open source ranges. */
export function* proseLines(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let next = 0;
  for (const [start,end] of fencedLineRanges(text)) {
    while (next < start) { yield [next,lines[next]]; next++; }
    next = end;
  }
  while (next < lines.length) { yield [next,lines[next]]; next++; }
}
