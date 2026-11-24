import { isMap, isScalar, parse, parseDocument, stringify, YAMLParseError } from "yaml";

function splitFrontmatter(source: string) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Agent has no canonical frontmatter");
  return { yaml: match[1] ?? "", prompt: match[2] ?? "" };
}

/** Isolate the name when legacy syntax in other fields prevents parsing the whole document. */
function legacyNameFields(source: string): unknown {
  const { yaml } = splitFrontmatter(source);
  const indent = /^( *)(?=[^\s#])/m.exec(yaml)?.[1] ?? "";
  // Split at top-level keys so YAML keeps continuations, block scalars and comments with their value.
  const entries = yaml.split(new RegExp(`^(?=${indent}[^\\s#][^\\r\\n]*?:(?:\\s|$))`, "m"));
  const names = entries.filter(entry => /^ *(?:name|'name'|"name")[ \t]*:(?=\s|$)/.test(entry));
  return names.length === 1 ? parse(names[0]!) : null;
}

/** Read the role from canonical YAML or from a repository definition with legacy metadata. */
export function agentFrontmatterName(source: string): string {
  let fields: unknown;
  try {
    fields = agentFrontmatter(source).metadata;
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    fields = legacyNameFields(source);
  }
  if (!fields || typeof fields !== "object" || !("name" in fields) || typeof fields.name !== "string" || !fields.name.trim()) {
    throw new Error("Agent frontmatter must declare one top-level string name");
  }
  return fields.name;
}

/** Read only the leading YAML metadata block, preserving the agent's complete prompt body. */
export function agentFrontmatter(source: string): { metadata: Record<string, unknown>; prompt: string } {
  const { yaml, prompt } = splitFrontmatter(source);
  const metadata: unknown = parse(yaml);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Agent frontmatter must be a mapping");
  return { metadata: metadata as Record<string, unknown>, prompt };
}

/** Replace only the description value. YAML node ranges preserve fences, comments and the prompt byte for byte. */
export function replaceFrontmatterDescription(source: string, description: string): string {
  const { yaml } = splitFrontmatter(source);
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw doc.errors[0];
  const scalar = isMap(doc.contents) ? doc.contents.get("description", true) : undefined;
  if (!isScalar(scalar) || typeof scalar.value !== "string" || !scalar.range) {
    throw new Error("Frontmatter must declare one string description");
  }
  const headerStart = source.indexOf("\n") + 1;
  const start = headerStart + scalar.range[0];
  const end = headerStart + Math.min(scalar.range[1], yaml.length);
  const token = isMap(doc.contents) && doc.contents.flow ? JSON.stringify(description) : stringify(description, { lineWidth: 0, blockQuote: false }).trimEnd();
  const newline = /(?:\r\n|\n)$/.exec(source.slice(start, end))?.[0] ?? "";
  const blockComment = scalar.type === "BLOCK_LITERAL" || scalar.type === "BLOCK_FOLDED"
    ? /^[>|][^#\r\n]*?([ \t]+#[^\r\n]*)[\r\n]/.exec(source.slice(start, end))?.[1] ?? "" : "";
  return source.slice(0, start) + token + blockComment + newline + source.slice(end);
}
