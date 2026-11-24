/** Indexed Markdown source lines outside backtick and tilde fences, including unclosed fences. */
export function* proseLines(text) {
  let fence = null;
  for (const [index,line] of text.split(/\r?\n/).entries()) {
    if (fence) {
      const closing = /^\s*([`~]+)\s*$/.exec(line)?.[1];
      if (closing && closing.length >= fence.length && [...closing].every(ch=>ch === fence[0])) fence=null;
      continue;
    }
    const opening = /^ {0,3}(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence=opening[1];
      continue;
    }
    if (!fence) yield [index,line];
  }
}
