// Diff rules for writes to stored data: a schema migration that changes an existing table or backfills it without a
// recorded precedent, a captured artifact field written with no capture call, a transaction that returns an error after
// it wrote, and an artifact-link delete wider than one edge. diff-rules.mjs runs them.

import { lineIndex } from "./line-index.mjs";

const SQL_TABLE_TOUCH = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|(?<!\bON\s{1,10})UPDATE\s+)"?(\w+)"?/gi;
export const SQL_CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
const SQL_UPDATE_STATEMENT = /(?<!\bON\s{1,10})\bUPDATE\s+"?(\w+)"?[^;]*;/gi;
const ARTIFACT_WRITE = /\.artifact\.(?:update|updateMany|upsert)\(|\bUPDATE\s+"?artifacts"?\s/i;
const CAPTURED_FIELD = /\b(?:status|priority|assigneeId|approverId|projectId|title|dueDate)\s*:|"(?:status|priority|assignee_id|approver_id|project_id|title|due_date)"\s*=/;
const CAPTURE_CALL = /\bcapture[A-Z]\w*\(/;
const TX_OPEN = /withDb\.tx\(/g;
const TX_WRITE = /\btx\.(?:\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw)/;
const RESULT_ERR_RETURN = /\breturn\s+(?:Result\.)?err\(/;
const LINK_DELETE = /\.artifactLink\.deleteMany\(|\bDELETE\s+FROM\s+"?artifact_links"?/i;
const LINK_EDGE_KEYS = [/\bsourceId\b|\bsource_id\b/, /\btargetId\b|\btarget_id\b/, /\blinkType\b|\blink_type\b/];
const WINDOW = 25;

export function checkMigrations(files, repo, logged, add, requiredChecks) {
  const { migrations } = repo.rules;
  let touched = false;
  for (const file of files) {
    const match = migrations.server?.exec(file.path);
    if (!match && !migrations.desktop?.test(file.path)) {
      continue;
    }
    touched = true;
    if (!match || file.status !== "A") {
      continue;
    }
    const sql = repo.head(file.path) ?? "";
    const created = new Set([...sql.matchAll(SQL_CREATE_TABLE)].map((found) => found[1]));
    const existing = new Set([...sql.matchAll(SQL_TABLE_TOUCH)].map((found) => found[1]).filter((table) => !created.has(table)));
    for (const table of existing) {
      if (!logged(`Migration precedent: ${table}:`)) {
        add("migration-precedent", file.path, 1, `changes existing table ${table} without a recorded lock-strategy precedent`, `copy the last three migrations on ${table} and record \`Migration precedent: ${table}: <folders>\``);
      }
    }
    for (const update of sql.matchAll(SQL_UPDATE_STATEMENT)) {
      if (!/\bWHERE\b/i.test(update[0]) && !logged(`Migration precedent: ${update[1]}:`)) {
        add("migration-backfill", file.path, 1, `full-table UPDATE of ${update[1]} in a schema migration`, `move or bound the backfill as ${update[1]}'s precedent does, and record \`Migration precedent: ${update[1]}: <folders>\``);
      }
    }
  }
  if (touched) {
    requiredChecks.push(...migrations.checks.map(({ command, reason }) => ({ command, reason })));
  }
}

function headWindow(head, line) {
  return head.split("\n").slice(line - 1, line - 1 + WINDOW).join("\n");
}

export function checkActivityCapture(file, head, logged, add, { fix }) {
  if (CAPTURE_CALL.test(head) || logged("Activity capture:", file.path)) {
    return;
  }
  for (const entry of file.added) {
    if (ARTIFACT_WRITE.test(entry.text) && CAPTURED_FIELD.test(headWindow(head, entry.line))) {
      add("activity-capture", file.path, entry.line, "writes a captured artifact field with no capture call in the file", fix);
    }
  }
}

/** Line ranges (1-based, inclusive) of each `withDb.tx(` callback body in `head`. */
export function transactionBodies(head) {
  const bodies = [];
  const lineAt = lineIndex(head);
  for (const open of head.matchAll(TX_OPEN)) {
    const start = head.indexOf("{", open.index);
    if (start < 0) {
      continue;
    }
    let depth = 0;
    for (let index = start; index < head.length; index += 1) {
      depth += head[index] === "{" ? 1 : head[index] === "}" ? -1 : 0;
      if (depth === 0) {
        bodies.push([lineAt(start), lineAt(index)]);
        break;
      }
    }
  }
  return bodies;
}

export function checkTransactions(file, head, add) {
  const lines = head.split("\n");
  const added = new Set(file.added.map((entry) => entry.line));
  for (const [first, last] of transactionBodies(head)) {
    let wroteAt = 0;
    for (let line = first; line <= last; line += 1) {
      const text = lines[line - 1] ?? "";
      if (TX_WRITE.test(text)) {
        wroteAt ||= line;
      } else if (wroteAt && RESULT_ERR_RETURN.test(text) && (added.has(line) || added.has(wroteAt))) {
        add("tx-result-after-write", file.path, line, `returns an error after the write at line ${wroteAt}, so the transaction commits a partial change`, "validate before the first write, or throw so withDb.tx rolls back");
      }
    }
  }
}

export function checkLinkDeletes(file, head, add) {
  for (const entry of file.added.filter((item) => LINK_DELETE.test(item.text))) {
    const window = headWindow(head, entry.line);
    if (!LINK_EDGE_KEYS.every((key) => key.test(window))) {
      add("artifact-link-delete", file.path, entry.line, "deletes artifact links not scoped to sourceId, targetId and linkType", "delete only the exact edge the write replaces");
    }
  }
}
