import MarkdownIt from "markdown-it";

// The CommonMark block pass supplies source positions. Inline parsing and rendering are unnecessary.
const markdown = new MarkdownIt("commonmark").disable("inline");

/** Source ranges of fenced code blocks, including fences nested in lists and block quotes. */
export function fencedLineRanges(text) {
  return markdown.parse(text,{}).filter(token => token.type === "fence").map(token => token.map);
}
