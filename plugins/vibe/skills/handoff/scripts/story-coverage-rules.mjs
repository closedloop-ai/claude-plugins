import path from "node:path";
import { storyFlagBindings, exportedStoryRenderer, registeredStoryNames, storyCollectionGlobs, storyFlagArms } from "../../vibe/scripts/dist/qa-impact-parser.mjs";
// Reconcile new flag arms and explicit current release-history claims with story source.
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { pathMatcher } from "./path-gates.mjs";
import { createImportClosure, resolveImport } from "./source-imports.mjs";
import { readStorybookRules } from "./storybook-rules.mjs";
import { storyMetaTitle } from "./storybook-taxonomy.mjs";

const STORY = /\.stories\.[cm]?[jt]sx?$/;
const FLAG = /\bexport\s+const\s+([A-Z]\w*FLAG_KEY)\s*=\s*(["'])([\w-]+)\2/g;
const HISTORY_VERSION = /\bversion\s*:\s*(["'])(\d+\.\d+\.\d+)\1/g;
const HISTORY_STATE = /["']((?:Foundations|Primitives|Composites|Patterns|Surfaces)\/[^:"'\n]+):\s*(?:(?:new\s+([A-Z][\w -]*?)\s+story)|(?:([A-Z][\w -]*?)\s+(?:added|was added|now available)))\b/g;
const HISTORY_LIST = /["']((?:Foundations|Primitives|Composites|Patterns|Surfaces)\/[^:"'\n]+):\s*new,\s+with\s+([^."'\n]+)(?=[."'])/g;
const HISTORY_COUNT = /\blevel:\s*(["'])(Primitives|Composites|Patterns|Surfaces)\1\s*,\s*entries:\s*(\d+)\s*,\s*stories:\s*(\d+)/g;

const COLLECTION_CONFIG = /(?:^|\/)\.storybook\/main\.[cm]?[jt]s$/;

function collection(repo) {
  const configs = repo.headFiles.filter(file => COLLECTION_CONFIG.test(file));
  const patterns = configs.flatMap(file => storyCollectionGlobs(repo.head(file) ?? "")
    .map(glob => path.posix.join(path.posix.dirname(file), glob)));
  return file => STORY.test(file) && (!configs.length || patterns.some(pattern => path.matchesGlob(file, pattern)));
}

/** Returns the current release record supplied by the repository's declared Storybook owner. */
export function currentStorybookRelease(read, paths) {
  const release = readStorybookRules(read)?.config?.release;
  if (!release?.versionFile) return null;
  let version;
  try { version = JSON.parse(read(release.versionFile) ?? "")[release.versionField ?? "version"]; }
  catch { return null; }
  if (typeof version !== "string") return null;
  const matchers = (release.historyFiles ?? []).map(pathMatcher);
  const files = paths.filter((file) => matchers.some((matches) => matches(file)));
  const records = [];
  for (const file of files) {
    const text = read(file) ?? "";
    const versions = [...text.matchAll(HISTORY_VERSION)];
    versions.forEach((match, index) => {
      if (match[2] === version) {
        records.push({ file, text: text.slice(match.index, versions[index + 1]?.index), offset: match.index, prefix: text });
      }
    });
  }
  const history = records.length === 1 ? records[0] : null;
  const counts = new Map([...(history?.text ?? "").matchAll(HISTORY_COUNT)]
    .map(([, , level, entries, stories]) => [level.toLowerCase(), { entries: Number(entries), stories: Number(stories) }]));
  return { version, counts, history, versionFile: release.versionFile };
}

function checkFlagStoryArms(files, repo, add, collected) {
  if (!repo.wordFiles) return;
  for (const file of files.filter((entry) => entry.status !== "D" && /\.[jt]sx?$/.test(entry.path)
    && entry.added.some(({ text }) => /FLAG_KEY\b/.test(text)))) {
    const before = repo.base(file.oldPath ?? file.path) ?? "";
    const prior = new Set([...before.matchAll(FLAG)].map((match) => match[3]));
    const flags = [...(repo.head(file.path) ?? "").matchAll(FLAG)].filter((match) => !prior.has(match[3]));
    for (const [, name, , key] of flags) {
      const sourceFiles = new Set(files.map(candidate => candidate.path));
      const paths = new Set([...repo.headFiles,...sourceFiles]);
      const bindingCache = new Map(), pending = new Set();
      function binding(candidate) {
        if (!bindingCache.has(candidate)) bindingCache.set(candidate,storyFlagBindings(repo.head(candidate) ?? "",name,candidate === file.path,
          (module,symbol) => from(candidate,module,symbol)));
        return bindingCache.get(candidate);
      }
      function from(candidate,module,symbol) {
        const target = resolveImport(candidate,module,paths), id = JSON.stringify([target,symbol]);
        if (!target || pending.has(id)) return false;
        pending.add(id);
        try { return binding(target).exported(symbol); } finally { pending.delete(id); }
      }
      // Search the flag's real export names and aliases without reading every module in the repository.
      const aliases = new Set([name]);
      const checked = new Set();
      for (const alias of aliases) for (const candidate of repo.wordFiles(alias)) {
        sourceFiles.add(candidate);
        if (checked.has(candidate) || !/\.[cm]?[jt]sx?$/.test(candidate)) continue;
        checked.add(candidate);
        const found = binding(candidate);
        for (const exported of found.names) if (found.exported(exported)) aliases.add(exported);
      }
      const owners = [...sourceFiles].filter(candidate => /\.[cm]?[jt]sx?$/.test(candidate) && !STORY.test(candidate) && !isTestFile(candidate)
        && binding(candidate).consumes());
      if (!owners.length) continue;
      const closure = createImportClosure(paths, (files) => new Map(files.map((file) => [file, repo.head(file) ?? ""])));
      const stories = [...paths].filter(collected).map((candidate) => ({
        path: candidate, text: repo.head(candidate) ?? "", imports: closure([candidate]),
      }));
      for (const owner of owners) {
        const memo = new Map();
        function reaches(origin, module, symbol, children = false, callOnly = false, forwarding = false, decorator = false, seen = new Set()) {
          const target = resolveImport(origin,module,paths);
          if (!target || (!children && !decorator && !closure([target]).has(owner))) return false;
          const id = JSON.stringify([target,symbol,children,callOnly,forwarding,decorator]);
          if (seen.has(id)) return false;
          if (memo.has(id)) return memo.get(id);
          const result = exportedStoryRenderer(repo.head(target) ?? "",symbol,name,
            (mod,key) => from(target,mod,key),
            (mod,key,nested,called,decorating) => reaches(target,mod,key,nested,called,forwarding,decorating,new Set([...seen,id])),!forwarding && target === owner,target === file.path,children,callOnly,decorator);
          if (!seen.size || result) memo.set(id,result);
          return result;
        }
        const arms = stories.filter(story => story.imports.has(owner)).flatMap(story =>
          storyFlagArms(story.text, {name,key}, (module, symbol) =>
            from(story.path,module,symbol), undefined, (module,symbol,children,called,forwarding,decorating) => reaches(story.path,module,symbol,children,called,forwarding,decorating)));
        const hasOn = arms.includes("on"), hasOff = arms.includes("off");
        if (!hasOn || !hasOff) add("flag-story-arms", file.path, file.added[0]?.line ?? 1,
          "new UI flag " + key + " lacks a registered " + (!hasOn && !hasOff ? "flag-on and flag-off" : !hasOn ? "flag-on" : "flag-off") + " story state for " + owner,
          "cover both values on the actual surface story, wiring the real flag provider or its fixture override");
      }
    }
  }
}

function checkVersionHistoryStates(files, repo, add, collected) {
  const release = readStorybookRules(repo.head)?.config?.release;
  if (!release) return;
  const matchers = (release.historyFiles ?? []).map(pathMatcher);
  if (!files.some((file) => file.path === release.versionFile || COLLECTION_CONFIG.test(file.path) || COLLECTION_CONFIG.test(file.oldPath ?? "") || collected(file.path) || collected(file.oldPath ?? "") || matchers.some((matches) => matches(file.path)))) return;
  const history = currentStorybookRelease(repo.head, repo.headFiles)?.history;
  if (!history) return;
  const named = [...history.text.matchAll(HISTORY_STATE)]
    .map(match => ({title:match[1],state:match[2] ?? match[3],index:match.index}));
  for (const match of history.text.matchAll(HISTORY_LIST)) {
    for (const state of match[2].split(/,\s*(?:and\s+)?|\s+and\s+/).map(value => value.trim()).filter(Boolean)) {
      named.push({title:match[1],state,index:match.index});
    }
  }
  if (!named.length) return;
  const statesByTitle = new Map();
  for (const file of repo.headFiles.filter(collected)) {
    const source = repo.head(file);
    if (!source) continue;
    const title = storyMetaTitle(source);
    if (!title || !named.some((entry) => entry.title === title)) continue;
    const names = registeredStoryNames(source, undefined, true);
    statesByTitle.set(title, new Set([...(statesByTitle.get(title) ?? []), ...names]));
  }
  const normalize = (text) => text.toLowerCase().replace(/[^\w]/g, "");
  for (const match of named) {
    const {title,state} = match;
    if ([...(statesByTitle.get(title) ?? [])].some((name) => normalize(name) === normalize(state))) continue;
    const line = history.prefix.slice(0, history.offset + match.index).split("\n").length;
    add("storybook-history-state", history.file, line, "current Version History claims an unregistered story state: " + title + " / " + state,
      "register and validate that state in the owning story, or correct the release claim");
  }
}

/** Writer and handoff share the same flag/story and current release-state coverage checks. */
export function checkStoryStateCoverage(files, repo, add) {
  const collected = collection(repo);
  checkFlagStoryArms(files, repo, add, collected);
  checkVersionHistoryStates(files, repo, add, collected);
}
