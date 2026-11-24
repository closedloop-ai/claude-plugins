/** Indexed prose outside Markdown fences, with indentation measured relative to the enclosing list item. */
export function* proseLines(text) {
  const containers = [];
  let fence = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    // CommonMark uses four-column tab stops for structural indentation. Preserve original prose bytes.
    let column = 0;
    const layout = line.replace(/[^\t]+|\t/g, part => {
      if (part !== "\t") { column += part.length; return part; }
      const spaces = 4 - column % 4;
      column += spaces;
      return " ".repeat(spaces);
    });
    const indent = /^ */.exec(layout)[0].length;
    if (fence && (indent >= fence.container || !line.trim())) {
      const closing = /^( {0,3})([`~]+)[ \t]*$/.exec(layout.slice(fence.container));
      if (closing && closing[2].length >= fence.marker.length && [...closing[2]].every(ch => ch === fence.marker[0])) fence = null;
      continue;
    }
    fence = null;
    if (line.trim()) while (containers.length && indent < containers.at(-1)) containers.pop();
    let container = containers.at(-1) ?? 0;
    while (true) {
      const rest=layout.slice(container);
      const marker=/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?= |$)/.exec(rest);
      if(!marker) break;
      const content=rest.slice(marker[0].length);
      const padding=/^ */.exec(content)[0].length;
      // An empty item uses one column. Five or more spaces on nonempty content are code indentation.
      const width=content.trim() && padding<=4 ? padding : 1;
      container+=marker[0].length+width;
      containers.push(container);
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(layout.slice(container));
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { marker: opening[1], container };
      continue;
    }
    yield [index, line];
  }
}
