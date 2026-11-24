import { createHash } from "node:crypto";
import { topLevelTestCases } from "../../vibe/scripts/dist/qa-impact-parser.mjs";
import { validTestSupersession } from "../../vibe/scripts/retired-tests.mjs";

/** The independently authorized case proof, carried in the private decision table. */
export function testSupersessionApprovals(text) {
  const section = /^## Authorized assertion supersessions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const rows = new Set([...text.matchAll(/^\|\s*(DT-[A-Za-z0-9.-]+)\s*\|/gm)].map(([, row]) => row));
  return [...section.matchAll(/^[-*] Assertion supersession: (\{.+\})$/gm)].flatMap(([, json]) => {
    try {
      const record = JSON.parse(json);
      return rows.has(record?.supersession?.row) ? [record] : [];
    } catch { return []; }
  });
}

function key(record) {
  const proof = record?.supersession;
  if (!validTestSupersession(proof)) return null;
  return JSON.stringify([record.path, record.case, record.retiredBy, record.covers, proof.base, proof.row,
    proof.source, proof.reason, proof.replacementCase ?? null,
    proof.changes.map(({ index, oldSha256, newSha256 }) => [index, oldSha256, newSha256])]);
}

const digest = (text, { start, end }) => createHash("sha256").update(text.slice(start, end)).digest("hex");

/** Exact old/new assertion spans, only when each private receipt matches the approved case proof. */
export function supersededAssertionSpans(file, before, after, { records = [], approvals = [], base } = {}) {
  if (file.status !== "M") return [];
  const allowed = new Set(approvals.map(key).filter(Boolean));
  const candidates = records.filter((record) => record?.path === file.path && record?.supersession?.base === base
    && allowed.has(key(record)));
  if (candidates.length === 0) return [];
  const oldCases = topLevelTestCases(file.path, before, true) ?? [];
  const newCases = topLevelTestCases(file.path, after, true) ?? [];
  return candidates.flatMap((record) => {
    const previous = oldCases.filter(({ name }) => name === record.case);
    const next = newCases.filter(({ name }) => name === (record.supersession.replacementCase ?? record.case));
    if (previous.length !== 1 || next.length !== 1 || previous[0].runner !== next[0].runner
      || candidates.filter((other) => other.case === record.case).length !== 1) return [];
    const verified = record.supersession.changes.flatMap(({ index, oldSha256, newSha256 }) => {
      const prior = previous[0].assertions?.[index - 1];
      const current = next[0].assertions?.[index - 1];
      return prior && current && digest(before, prior) === oldSha256 && digest(after, current) === newSha256
        ? [{ prior, current }] : [];
    });
    return verified.length === record.supersession.changes.length ? verified : [];
  });
}
