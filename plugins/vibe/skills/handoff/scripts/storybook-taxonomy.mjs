// Storybook taxonomy reading for the handoff inventory: a story file's meta
// title, tags and exported story names, and which story files a base commit
// treats as the frozen v1.0 baseline.
//
// symphony-alpha has used two schemes, and a session is judged by the one its
// base uses, so a branch still on an older main keeps its rules until it
// syncs (design ruling, 2026-10-16):
// - Version scheme, before symphony-alpha #8867 (ISS-12610): the plain level
//   roots (`Composites/`) and the `v1.0` tag are the v1.0 baseline; new work
//   goes under `<Level> v2.0/` tagged `v2.0`.
// - Lifecycle scheme, from #8867 (Storybook 3.0.0): the `<Level> v1.0/` roots
//   and the `deprecated` lifecycle tag are the v1.0 baseline; new work goes
//   under the plain roots with one lifecycle tag (`stable`, `preview`,
//   `experimental`).
// The base's own apps/storybook/story-group-order.ts says which: it exports
// `StorybookLifecycle` only in the lifecycle scheme, and there the frozen tag
// is that object's `Deprecated` value and every frozen root ends in
// `storybookBaselineVersion`, the same test symphony-alpha's
// validate-story-titles.mjs applies. Reading them from the base keeps the next
// rename there from breaking these checks. The version scheme is closed
// history whose file declares neither, so its two patterns stay written here.

export const STORY_GROUP_ORDER_PATH = "apps/storybook/story-group-order.ts";

export const StorybookScheme = {
  Version: "version",
  Lifecycle: "lifecycle",
  Unrecognized: "unrecognized",
};

// The first title segment that carries no version or lifecycle stage, as
// symphony-alpha's .storybook/manager.ts treats it (design ruling, 2026-10-06).
export const UNVERSIONED_STORY_ROOT = "Start Here";

const VERSION_SCHEME_FROZEN_TITLE = /\btitle:\s*["'`](?:Foundations|Primitives|Composites|Surfaces)\//;
const VERSION_SCHEME_FROZEN_TAG = /\btags:\s*\[[^\]]*["'`]v1\.0["'`]/;
const LIFECYCLE_EXPORT = /\bexport\s+const\s+StorybookLifecycle\s*=/;
const LIFECYCLE_MEMBERS = /\bexport\s+const\s+StorybookLifecycle\s*=\s*\{([^}]*)\}/;
const LIFECYCLE_MEMBER = /\b(\w+)\s*:\s*(["'`])([^"'`]+)\2/g;
const DEPRECATED_MEMBER = "Deprecated";
const BASELINE_VERSION = /\bexport\s+const\s+storybookBaselineVersion\s*=\s*(["'`])([^"'`]+)\1/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
// The meta object's title, not a `title:` arg or prop elsewhere in the file.
const STORY_META_START = /\b(?:const\s+meta\b[^=]*=|export\s+default)\s*\{/;
const STORY_META_TITLE = /\btitle:\s*(["'`])((?:(?!\1).)+)\1/;
const STORY_META_TAGS = /\btags:\s*\[([^\]]*)\]/;
const STRING_LITERAL = /(["'`])((?:(?!\1).)*)\1/g;
const NAMED_EXPORT = /\bexport\s+(?:const|let|var|function\*?|class)\s+([\w$]+)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const EXPORT_ALIAS = /\s+as\s+/;
const REGEX_PRECEDER = "(,=:[!&|?{};+-*%<>~^";
const WHITESPACE = /\s/;

/**
 * The scheme a base's story-group-order.ts declares (undefined when the base
 * has none: the version scheme). `frozenTitle` and `frozenTag` say whether a
 * story file's source places it in the v1.0 baseline by title or by tag;
 * `summary` is what the inventory reports.
 */
export function storybookSchemeOf(orderSource) {
  if (orderSource === undefined || !LIFECYCLE_EXPORT.test(orderSource)) {
    return {
      summary: { name: StorybookScheme.Version },
      frozenTitle: (source) => VERSION_SCHEME_FROZEN_TITLE.test(source),
      frozenTag: (source) => VERSION_SCHEME_FROZEN_TAG.test(source),
    };
  }
  const members = [...(LIFECYCLE_MEMBERS.exec(orderSource)?.[1] ?? "").matchAll(LIFECYCLE_MEMBER)];
  const deprecatedTag = members.find((member) => member[1] === DEPRECATED_MEMBER)?.[3];
  const baselineVersion = BASELINE_VERSION.exec(orderSource)?.[2];
  if (deprecatedTag === undefined || baselineVersion === undefined) {
    return {
      summary: {
        name: StorybookScheme.Unrecognized,
        problem: `${STORY_GROUP_ORDER_PATH} exports StorybookLifecycle but no readable ${DEPRECATED_MEMBER} tag or storybookBaselineVersion; update the vibe plugin before handing off story changes.`,
      },
      frozenTitle: () => false,
      frozenTag: () => false,
    };
  }
  const rootSuffix = ` ${baselineVersion}`;
  const tag = new RegExp(String.raw`\btags:\s*\[[^\]]*["'\`]${deprecatedTag.replace(REGEXP_SPECIAL, String.raw`\$&`)}["'\`]`);
  return {
    summary: {
      name: StorybookScheme.Lifecycle,
      frozenTag: deprecatedTag,
      frozenRoots: `<Level>${rootSuffix}`,
      lifecycleTags: members.map((member) => member[3]),
    },
    frozenTitle: (source) => storyTitleRoot(source)?.endsWith(rootSuffix) === true,
    frozenTag: (source) => tag.test(source),
  };
}

/** A story file whose meta title's root is Start Here, which carries no version. */
export function isUnversionedStory(source) {
  return source !== undefined && storyTitleRoot(source) === UNVERSIONED_STORY_ROOT;
}

export function storyMetaTitle(source) {
  const start = source.search(STORY_META_START);
  return STORY_META_TITLE.exec(start === -1 ? source : source.slice(start))?.[2] ?? null;
}

export function storyMetaTags(source) {
  const start = source.search(STORY_META_START);
  const tags = STORY_META_TAGS.exec(start === -1 ? source : source.slice(start))?.[1];
  return tags === undefined ? null : [...tags.matchAll(STRING_LITERAL)].map((match) => match[2]);
}

export function storyExportNames(source) {
  const code = codeOnly(source);
  const names = new Set([...code.matchAll(NAMED_EXPORT)].map((match) => match[1]));
  for (const [, list] of code.matchAll(EXPORT_LIST)) {
    for (const entry of list.split(",")) {
      const name = entry.trim().split(EXPORT_ALIAS).at(-1);
      if (name && name !== "default") {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Whether `source` keeps `base`'s title, tags and exported story names, so every story ID stays the same: the
 * test for a compile-only repair of a frozen v1.0 story file.
 */
export function keepsStoryIdentity(base, source) {
  return (
    storyMetaTitle(base) === storyMetaTitle(source) &&
    JSON.stringify(storyMetaTags(base)) === JSON.stringify(storyMetaTags(source)) &&
    JSON.stringify(storyExportNames(base)) === JSON.stringify(storyExportNames(source))
  );
}

/**
 * `source` with the contents of every string, template literal, regular expression and comment replaced by spaces
 * (line breaks kept), so a pattern over it sees only code: a fixture string holding `export const` is not an export
 * (ISS-13317). Template substitutions stay code. A `/` starts a regular expression only where an expression can
 * start, judged by the previous code character.
 */
function codeOnly(source) {
  const out = [...source];
  const templates = [];
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  const skipTemplate = () => {
    const start = i;
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") {
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        blank(start, i);
        i += 2;
        templates.push(0);
        return;
      } else {
        i++;
      }
    }
    blank(start, i);
    i++;
  };
  let previous = "";
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (char === "\"" || char === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== char && source[k] !== "\n") {
        k += source[k] === "\\" ? 2 : 1;
      }
      blank(i + 1, k);
      i = k + 1;
      previous = char;
    } else if (char === "`") {
      i++;
      skipTemplate();
      previous = "`";
    } else if (char === "/" && (previous === "" || REGEX_PRECEDER.includes(previous))) {
      let k = i + 1;
      let inClass = false;
      while (k < source.length && source[k] !== "\n" && (inClass || source[k] !== "/")) {
        if (source[k] === "\\") k++;
        else if (source[k] === "[") inClass = true;
        else if (source[k] === "]") inClass = false;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      previous = "/";
    } else if (templates.length && (char === "{" || char === "}")) {
      if (char === "{") {
        templates[templates.length - 1]++;
        i++;
      } else if (templates.at(-1) > 0) {
        templates[templates.length - 1]--;
        i++;
      } else {
        templates.pop();
        i++;
        skipTemplate();
      }
      previous = char;
    } else {
      if (!WHITESPACE.test(char)) previous = char;
      i++;
    }
  }
  return out.join("");
}

function storyTitleRoot(source) {
  return storyMetaTitle(source)?.split("/")[0].trim();
}
