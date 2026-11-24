import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { createImportClosure, escapeRegExp, importSpecifiers, resolveImport } from "./source-imports.mjs";
import { testAssertionCases } from "./test-repair-moves.mjs";

function byPath(read) {
  return (files) => new Map(files.map((file) => [file, read(file)]));
}

/** Every assertion in a wholly deleted JS/TS test needs a live owner and replacement, or a verified retired source. */
export function checkRetiredTestDeletions(files, repo, add) {
  const removed = files.filter(({ path, status }) => status === "D" && isTestFile(path));
  if (removed.length === 0) return;
  let records;
  try { records = repo.retiredTests?.() ?? []; }
  catch (error) {
    for (const file of removed) add("retired-test-record", file.path, 1, error.message, "restore a valid private retired test record before deleting this file");
    return;
  }
  for (const file of removed) {
    const record = records.find((entry) => entry.path === file.path && entry.case === undefined);
    const emit = (message) => add("retired-test-record", file.path, 1, message,
      "record the whole-file entry and one assertion-map row for each old assertion. Keep live assertions in current runnable tests through their source owner.");
    if (!record) {
      emit("test file is deleted without its whole-file retirement record");
      continue;
    }
    checkDeletedAssertions(file.path, record, repo, emit);
  }
}

function checkDeletedAssertions(file, record, repo, emit) {
  const before = testAssertionCases(file, repo.base(file));
  const assertions = before.flatMap((entry) => entry.assertions.map((statement, index) => ({ name: entry.name, index: index + 1, statement })));
  if (assertions.length === 0) {
    emit("deleted file has no machine-readable runnable assertion census; preserve its tests until the retirement evidence can be verified");
    return;
  }
  const baseOwners = createImportClosure(repo.baseFiles, repo.baseBlobs ?? byPath(repo.base))([file]);
  const headOwners = createImportClosure(new Set(repo.headFiles), byPath(repo.head));
  for (const { name, index, statement } of assertions) {
    const rows = (record.assertions ?? []).filter((item) => item.case === name && item.index === index);
    if (rows.length !== 1 || !baseOwners.has(rows[0]?.source) || !repo.base(rows[0]?.source)) {
      emit(`deleted assertion ${name} #${index} has no unique mapped production owner in the captured base`);
      continue;
    }
    const { source, replacement } = rows[0];
    if (!repo.head(source) && !replacement) continue;
    const next = replacement && testAssertionCases(replacement.path, repo.head(replacement.path)).filter((entry) => entry.name === replacement.case);
    const proves = next?.length === 1 && headOwners([replacement.path]).has(source)
      && next[0].assertions.some(({ norm }) => norm === statement.norm);
    if (!proves) emit(`live deleted assertion ${name} #${index} lacks a current failing-capable replacement reaching ${source}`);
  }
}

const CODE = /\.[cm]?[jt]sx?$/;
const BRANCH = /\b([a-z]\w*)\?\.([a-z]\w*)\b/gi;

function retiredGuards(key, files, repo) {
  const result = [];
  const token = new RegExp(`${escapeRegExp(key)}|${escapeRegExp(key.replace(/[^\w]/g, "_").toUpperCase())}_(?:FEATURE_)?FLAG`);
  for (const file of files.filter(({ path, status }) => status !== "D" && CODE.test(path))) {
    const before = repo.base(file.oldPath ?? file.path) ?? "";
    const current = repo.head(file.path) ?? "";
    if (!token.test(before) && !file.removed?.some(({ text }) => token.test(text))) continue;
    for (const [, prop, guard] of current.matchAll(BRANCH)) {
      const priorUses = new RegExp(`\\b${escapeRegExp(prop)}\\b`);
      if (priorUses.test(before) && !before.includes(`${prop}?.${guard}`) && !result.some((entry) => entry.path === file.path && entry.prop === prop && entry.guard === guard)) {
        result.push({ path: file.path, prop, guard });
      }
    }
  }
  return result;
}

function deadHostProp({ path, prop, guard }, owner, text, paths) {
  const injects = new RegExp(`\\b${escapeRegExp(prop)}\\s*=\\s*\\{\\s*([A-Za-z_$][\\w$]*)`, "g");
  if (!importSpecifiers(owner, text).some((specifier) => resolveImport(owner, specifier, paths) === path)) return false;
  return [...text.matchAll(injects)].some(([, value]) => {
    const declaration = new RegExp(`\\b(?:const|let)\\s+${escapeRegExp(value)}\\s*=\\s*(?:[^;]+?=>\\s*)?\\(?\\s*\\{([^}]*?)\\}`, "s").exec(text);
    return declaration && !new RegExp(`\\b${escapeRegExp(guard)}\\s*:\\s*true\\b`).test(declaration[1]);
  });
}

/** A removed flag may leave producer-side props and documentation references behind after its visible arm disappears. */
export function checkRetiredFlagDependencies(key, files, repo, add) {
  const paths = new Set(repo.headFiles);
  const docs = [...paths].filter((file) => /^docs\//.test(file));
  for (const file of docs) {
    const text = repo.head(file);
    if (text?.split("\n").some((line) => line.includes(key) && !/\b(?:retired|removed|historical)\b/i.test(line))) {
      add("flag-retirement-docs", file, 1, `documentation still names retired flag ${key} as live or without a historical disposition`,
        "remove the obsolete flag literal or mark its exact reference as historical in the document");
    }
  }
  for (const entry of retiredGuards(key, files, repo)) {
    const direct = repo.importersOf?.([entry.path])?.get(entry.path) ?? paths;
    for (const file of direct) {
      if (file === entry.path || !CODE.test(file) || !deadHostProp(entry, file, repo.head(file) ?? "", paths)) continue;
      add("flag-retirement-dead-host", file, 1, `host still constructs ${entry.prop} without ${entry.guard} after retiring ${key}`,
        "remove the dead producer or explicitly make its remaining supported branch active with verified user provenance");
    }
  }
}
