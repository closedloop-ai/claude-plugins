/** Indexed prose outside Markdown fences, with indentation measured relative to the enclosing list item. */
export function* proseLines(text) {
  const containers = [];
  let fence = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    // CommonMark uses four-column tab stops for structural indentation. Preserve original prose bytes.
    const layout = line.replace(/^(?:[ \t]*)(?=\S|$)/, prefix => {
      let columns = 0;
      for (const char of prefix) columns += char === "\t" ? 4 - columns % 4 : 1;
      return " ".repeat(columns);
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
    const marker = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: {1,4}(?! )|$)/.exec(layout.slice(container));
    if (marker) {
      container += marker[0].length + (marker[0].endsWith(" ") ? 0 : 1);
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
