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
  const names = new Set([...source.matchAll(NAMED_EXPORT)].map((match) => match[1]));
  for (const [, list] of source.matchAll(EXPORT_LIST)) {
    for (const entry of list.split(",")) {
      const name = entry.trim().split(EXPORT_ALIAS).at(-1);
      if (name && name !== "default") {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function storyTitleRoot(source) {
  return storyMetaTitle(source)?.split("/")[0].trim();
}
