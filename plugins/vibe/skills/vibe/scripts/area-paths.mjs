// The target repository's areas, shared by the handoff facts (pr-facts.mjs), the handoff inventory and the
// triage manifest (vibe-triage.mjs) so they cannot drift. A bound provider's recipe names them
// (`data.recipes.areas`: UI prefixes, the surfaces Desktop hosts, the paths that can change Desktop, the
// prototype folder and the backend paths). Without one there are no UI or Desktop prefixes (a UI file is
// known by its extension alone), no prototype folder, and backend means migrations and SQL only, so a file
// in no known area classifies as unknown and takes the full review path.

import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

/** Paths that cannot change what an environment builds: root docs, root Markdown files and the plugin and agent folders. A change outside this list is deploy-relevant (a shared package, the lockfile and root package.json included). */
export const NON_BUILD_PATH = /^(?:docs|\.claude|\.agents|\.context)\/|^[^/]+\.md$/;

const GENERIC_BACKEND = /(?:^|\/)(?:prisma|migrations)\/|\.sql$|schema\.prisma$/;
export const GENERIC_AREAS = Object.freeze({ ui: [], desktopHost: [], desktopRelevant: [], prototype: null, backend: GENERIC_BACKEND });

const UI_FILE = /\.(?:tsx|jsx|vue|svelte|css|scss|less|html)$/;

/** Whether `file` is UI in `areas`: under a recipe's UI prefix, or, with no prefixes to go by, a UI file by its extension. */
export function isUiFile(file, areas) {
  return areas.ui.length ? areas.ui.some((prefix) => file.startsWith(prefix)) : UI_FILE.test(file);
}

/** The repository's areas for `binding`: its provider recipe's, compiled, or GENERIC_AREAS. */
export function repositoryAreas(binding) {
  const data = providerDataOr(binding, "recipes", "areas", null);
  if (!data) return GENERIC_AREAS;
  return Object.freeze({
    ui: data.ui ?? [],
    desktopHost: data.desktopHost ?? [],
    desktopRelevant: data.desktopRelevant ?? [],
    prototype: data.prototype ? new RegExp(data.prototype) : null,
    backend: data.backend ? new RegExp(data.backend) : GENERIC_BACKEND,
  });
}

/** The areas of the session at `worktree` (or, before one exists, this conversation's binding). */
export function sessionAreas(worktree = null) {
  return repositoryAreas(sessionBinding(worktree));
}

/** The repository layout the bound provider's recipe names (`data.recipes.layout`), or `fallback`'s keys only. */
export function repositoryLayout(binding = sessionBinding(null)) {
  return providerDataOr(binding, "recipes", "layout", {});
}

/** The bound provider's prototype recipe (`data.recipes.prototypes`), or null without one. */
export function prototypeRecipe(binding = sessionBinding(null)) {
  return providerDataOr(binding, "recipes", "prototypes", null);
}
