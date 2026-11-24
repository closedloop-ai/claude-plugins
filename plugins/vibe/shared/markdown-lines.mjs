/** Indexed Markdown source lines outside backtick and tilde fences, including unclosed fences. */
export function* proseLines(text) {
  let fence = null;
  for (const [index,line] of text.split(/\r?\n/).entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (!fence) yield [index,line];
  }
}
