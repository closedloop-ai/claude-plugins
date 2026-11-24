// The thread/read capture grammar is shared by callers that require a single reply
// and those whose producer can emit more than one JSON document.
const white = /[ \t\r\n]/;

/** Find the end of one structured or quoted JSON value, honoring escaped quotes. */
function valueEnd(text, start) {
  const first = text[start];
  if (first !== "{" && first !== "[" && first !== '"') {
    const scalar = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?/y;
    scalar.lastIndex = start;
    return scalar.exec(text) ? scalar.lastIndex : -1;
  }
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === "\\") { index++; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "{" || char === "[")) depth++;
    else if (!quoted && (char === "}" || char === "]")) depth--;
    if (!quoted && depth === 0) return index + 1;
  }
  return -1;
}

/** Read the entire captured stream, preserving order and rejecting truncated or trailing output. */
export function capturedJsonDocuments(input) {
  const text = typeof input === "string" ? input : Buffer.isBuffer(input) ? input.toString("utf8") : null;
  if (text === null) throw new Error("Captured JSON input must be text");
  const values = [];
  let index = 0;
  while (index < text.length) {
    if (white.test(text[index])) { index++; continue; }
    const end = valueEnd(text, index);
    if (end < 0) throw new Error(`Invalid captured JSON at offset ${index}: incomplete value or trailing output`);
    try { values.push(JSON.parse(text.slice(index, end))); }
    catch { throw new Error(`Invalid captured JSON document at offset ${index}`); }
    index = end;
  }
  if (!values.length) throw new Error("Captured JSON is empty");
  return values;
}

/** Decode a command or protocol frame that promises exactly one JSON value. */
export function capturedJson(input) {
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try { return JSON.parse(input); } catch { /* Diagnose stream cardinality or trailing bytes below. */ }
  }
  const values = capturedJsonDocuments(input);
  if (values.length !== 1) throw new Error(`Expected one JSON document in captured output, received ${values.length}`);
  return values[0];
}
