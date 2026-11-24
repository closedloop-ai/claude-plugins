/** Indexed Markdown source lines outside backtick and tilde fences, including unclosed fences. */
export function* proseLines(text) {
  let fence = null;
  for (const [index,line] of text.split(/\r?\n/).entries()) {
    if (fence) {
      const closing = /^( *)([`~]+)[ \t]*$/.exec(line);
      if (closing && closing[1].length >= fence.indent && closing[1].length <= fence.indent + 3
        && closing[2].length >= fence.marker.length && [...closing[2]].every(ch=>ch === fence.marker[0])) fence=null;
      continue;
    }
    const opening = /^( {0,3})((?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[3][0] === "`" && opening[4].includes("`"))) {
      fence={marker:opening[3],indent:opening[2] ? opening[1].length+opening[2].length : 0};
      continue;
    }
    if (!fence) yield [index,line];
  }
}
