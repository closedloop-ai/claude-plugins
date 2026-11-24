import path from "node:path";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { createImportClosure, escapeRegExp, importSpecifiers, resolveImport } from "./source-imports.mjs";
import { testAssertionCases } from "./test-repair-moves.mjs";
import { testIntegrityProofShapeProblems } from "./test-integrity.mjs";

const CLAIM = /^\s*(?:[-*]\s+)?Fix surface:\s*([^:\n]+):\s*(\S.*)$/gm;
const HOST = /(?:^|\/)(?:page|route|[\w.-]+[-.]?(?:page|layout|screen|view|route)|[\w.-]+\.stories)\.[cm]?[jt]sx?$/i;
const TOUCH_FILE = /(?:touch.*(?:select|row|press)|long-press|use.*press.*touch)[\w.-]*\.[cm]?[jt]sx?$/i;
const TOUCH_CODE = /(?:pointerType|isInteractiveRowClickTarget|touchstart|longPress)/;

function routePath(file, names) {
  return typeof file === "string" && !file.startsWith("/") && !file.split("/").includes("..") && names.has(file);
}

function edge(from, to, text, names) {
  for (const specifier of importSpecifiers(from, text)) {
    if (resolveImport(from, specifier, names) !== to) continue;
    if (!/\.[cm]?[jt]sx?$/.test(from)) return true;
    const escaped = escapeRegExp(specifier);
    const declaration = new RegExp(`(?:^|;|\\n)\\s*(import|export)\\s+([^;]+?)\\s+from\\s*["']${escaped}["']`, "m").exec(text);
    if (!declaration || declaration[2].trimStart().startsWith("type ")) continue;
    if (declaration[1] === "export") return true;
    const symbols = [...declaration[2].matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]).filter((name) => name !== "as");
    const executable = text.replace(declaration[0], "").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, "");
    if (symbols.some((name) => new RegExp(`(?:<\\s*${escapeRegExp(name)}\\b|\\b${escapeRegExp(name)}\\s*\\(|\\b${escapeRegExp(name)}\\s*[,}])`).test(executable))) return true;
  }
  return false;
}

function verifiesMountedTest(test, host, target, title, repo, names) {
  const testSource = repo.head(test);
  if (!isTestFile(test) || !testSource || !createImportClosure(names, (files) => new Map(files.map((file) => [file, repo.head(file)])))([test]).has(host)) return false;
  const cases = testAssertionCases(test, testSource).filter(({ name, body }) => name === title && /\b(?:render|mount)\s*\(/.test(body));
  const proofs = repo.surfaceProofs?.()?.testIntegrityProofs ?? [];
  if (cases.length !== 1) return false;
  const proof = proofs.find((entry) => entry.path === test && entry.case === title && entry.commit === repo.currentHead?.()
    && entry.ownerBoundary === "production" && entry.mutation?.includes(target));
  return !!proof && testIntegrityProofShapeProblems({ testIntegrityProofs: [proof] }, repo.receiptDir, repo.head).length === 0;
}

/** Verify each stated UI fix against an actual changed reachable path or a source-bound red-first host test. */
export function surfaceFixProblems(claims, files, repo) {
  const records = [...String(claims ?? "").matchAll(CLAIM)];
  if (records.length === 0) return [];
  const names = new Set(repo.headFiles);
  const changed = new Set(files.filter(({ status }) => status !== "D").map(({ path }) => path));
  return records.flatMap(([, surface, entry]) => {
    const [walk, via] = entry.trim().split(/\s+via\s+/, 2);
    const parts = walk.split(/\s+->\s+/);
    const [host] = parts;
    const target = parts.at(-1);
    const matchesSurface = host.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(surface.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    const valid = HOST.test(host) && matchesSurface && parts.every((file) => routePath(file, names)) && changed.has(target);
    if (valid && !via && parts.slice(1).every((file, index) => edge(parts[index], file, repo.head(parts[index]) ?? "", names))) return [];
    if (valid && via) {
      const sep = via.lastIndexOf("#");
      const test = via.slice(0, sep);
      if (sep > 0 && routePath(test, names) && verifiesMountedTest(test, host, target, via.slice(sep + 1), repo, names)) return [];
    }
    return [{ file: target, reason: `${surface} has no verified render/import path from its real host to the changed file and no exact red-first mounted test` }];
  });
}

function touchCases(file, tests, repo) {
  const names = new Set(repo.headFiles);
  const closure = createImportClosure(names, (files) => new Map(files.map((entry) => [entry, repo.head(entry)])));
  return tests.filter((test) => closure([test]).has(file)).flatMap((test) => testAssertionCases(test, repo.head(test)))
    .filter(({ assertions }) => assertions.length).map(({ body, assertions }) => ({ body, assertions: assertions.map(({ norm }) => norm).join("\n") }));
}

function touchCoverage(cases) {
  const anchor = /<a\b[^>]*\bhref\s*=|createElement\(\s*["']a["']/i;
  const neutral = /<(?:span|div)\b|createElement\(\s*["'](?:span|div)["']/i;
  const touch = /(?:pointerType\s*:\s*["']touch|touchStart\s*\(|touchscreen\.)/i;
  const press = /(?:longPress|advanceTimersByTime|hold(?:For)?|pressTimer)/i;
  const anchorProof = cases.some(({ body, assertions }) => anchor.test(body) && touch.test(body) && press.test(body) &&
    /(?:interactive|link|anchor|menu|press)/i.test(assertions) && /(?:click|navigat|href|URL)/i.test(body)
    && /(?:click|navigat|href|URL)/i.test(assertions));
  const neutralProof = cases.some(({ body, assertions }) => neutral.test(body) && touch.test(body) && press.test(body) &&
    /(?:menu|press|call|open)/i.test(assertions));
  const cancelProof = cases.some(({ body, assertions }) => touch.test(body) && press.test(body) &&
    /(?:pointerMove|pointerCancel|touchMove|touchCancel)/i.test(body) && /(?:cancel|\.not\.|toHaveBeenCalledTimes\(0\))/i.test(assertions));
  return { anchorProof, neutralProof, cancelProof };
}

/** Touch handling changes require linked and ordinary leads with actual captured press, cancellation and click evidence. */
export function checkTouchLeadCoverage(files, repo, add, requiredTests) {
  const handlers = files.filter((file) => file.status !== "D" && !isTestFile(file.path) && TOUCH_FILE.test(file.path)
    && [...(file.added ?? []), ...(file.removed ?? [])].some(({ text }) => TOUCH_CODE.test(text)));
  for (const { path: file } of handlers) {
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, "");
    const tests = repo.headFiles.filter((test) => isTestFile(test) && (test.includes(stem) || /(?:touch|long-press)/i.test(test)));
    const { anchorProof, neutralProof, cancelProof } = touchCoverage(touchCases(file, tests, repo));
    const missing = [!anchorProof && "anchor lead with interactive handling and click/navigation", !neutralProof && "noninteractive lead with long press",
      !cancelProof && "touch movement/cancel and no unintended menu"].filter(Boolean);
    if (missing.length) add("touch-lead-coverage", file, 1, `touch fixtures lack ${missing.join(", ")}`,
      "exercise actual linked and plain leads through the touch handler, preserving normal clicks and navigation");
    else for (const test of tests) requiredTests.push({ path: test, reason: `touch lead matrix for ${file}` });
  }
}
