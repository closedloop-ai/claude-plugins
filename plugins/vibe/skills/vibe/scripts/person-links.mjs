// Builds the links vibe gives the person to the exact thing it points them at
// (ISS-13320): one story in the component gallery, or one page of the
// session's app. Both come from the session record, never from an id or a
// route pattern the person would have to resolve. `vibe-sessions.mjs link`
// reads the record and calls these; they are pure so the choice of base is
// testable without a running Storybook.

// Storybook story ids are lowercase words joined by `-`, with `--` between
// the title and the story name.
const STORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Route patterns (`[id]`, `[[...slug]]`, `:id`, `<id>`, `{id}`, `*`) are not
// pages anyone can open.
const ROUTE_PLACEHOLDER = /[[\]{}<>*]|(?:^|\/):/;

export const LinkSource = {
  Deployed: "deployed",
  Local: "local",
};

export const MissingLink = {
  Storybook: "storybook",
  App: "app",
};

/**
 * The full Storybook UI link for one story (`environment.md`, "Storybook
 * links"): the verified deployed Storybook when the session has one, else the
 * local Storybook the session started while its process runs. `local` asks
 * for the local Storybook only, for stories built since the last redeploy.
 * Returns `{ url: null, missing }` when neither exists.
 */
export function storyLink(record, storyId, { local = false, isRunning }) {
  if (!STORY_ID.test(storyId ?? "")) {
    throw new Error(`Not a Storybook story id: ${storyId}. Pass the id the story's index entry lists, such as components-button--primary.`);
  }
  const deployed = local ? null : deployedBase(record, "storybookUrl");
  const base = deployed ?? localStorybookBase(record, isRunning);
  if (!base) {
    return { url: null, missing: MissingLink.Storybook };
  }
  return { url: `${base}/?path=/story/${storyId}`, source: deployed ? LinkSource.Deployed : LinkSource.Local };
}

/**
 * The link to one real page of the session's app: the verified app URL plus
 * the page's path for the example data. Returns `{ url: null, missing }` when
 * the app is not deployed yet.
 */
export function pageLink(record, pagePath) {
  const page = realPagePath(pagePath);
  const base = deployedBase(record, "appUrl");
  if (!base) {
    return { url: null, missing: MissingLink.App };
  }
  return { url: `${base}${page}`, source: LinkSource.Deployed };
}

function deployedBase(record, key) {
  const vercel = record?.vercel;
  if (!vercel?.verifiedAt) {
    return null;
  }
  return httpBase(vercel[key]);
}

function localStorybookBase(record, isRunning) {
  const stack = record?.stack;
  if (!stack || !isRunning(stack.storybookPid)) {
    return null;
  }
  return httpBase(stack.storybookUrl);
}

function httpBase(value) {
  if (typeof value !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function realPagePath(pagePath) {
  if (typeof pagePath !== "string" || !pagePath.startsWith("/") || pagePath.startsWith("//") || /[\s\\]/.test(pagePath)) {
    throw new Error(`Not a page path: ${pagePath}. Pass the path after the app's address, starting with /.`);
  }
  const route = pagePath.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    throw new Error(`Not a page path: ${pagePath}.`);
  }
  if (ROUTE_PLACEHOLDER.test(decoded)) {
    throw new Error(`${pagePath} is a route pattern. Pass the real path for the example data, with its real ids.`);
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Not a page path: ${pagePath}.`);
  }
  return pagePath === "/" ? "" : pagePath;
}
