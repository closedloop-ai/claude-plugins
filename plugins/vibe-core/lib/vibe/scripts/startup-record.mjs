// The startup version record vibe's plugin-version.mjs writes for each
// conversation (operator rulings, 2026-10-16 and 2026-10-27), and the reads
// the vibe hooks make of it: whether the check ran, whether an outdated plugin
// is still unanswered, and whether the conversation loaded the installed skill.
// The record format is unchanged; plugin-version.mjs owns the check itself.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const VersionStatus = Object.freeze({ Current: "current", Outdated: "outdated", Unknown: "unknown", Pending: "pending" });
export const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
export const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** -1, 0 or 1 for two x.y.z versions, or null when either is not one. */
export function compareVersions(left, right) {
  const a = RELEASE_VERSION.exec(String(left ?? "").trim());
  const b = RELEASE_VERSION.exec(String(right ?? "").trim());
  if (!a || !b) {
    return null;
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** The installed vibe version reported for `runtime`, or null. */
export function installedVibeVersion(record, runtime) {
  const entry = (record?.harnesses ?? []).find((item) => item?.harness === runtime);
  return entry?.plugins?.find((plugin) => plugin?.name === "vibe")?.version ?? null;
}

/** Why this conversation must reload the current skill before another brief. */
export function loadedSkillProblem(record) {
  const loaded = record?.loadedSkill?.version;
  const installed = installedVibeVersion(record, record?.loadedSkill?.runtime ?? record?.runtime);
  const order = compareVersions(loaded, installed);
  return order !== null && order < 0
    ? `the conversation loaded vibe ${loaded}, but ${installed} is installed; reload the current vibe/fleet skill before sending another brief`
    : null;
}

/** Where this conversation's startup record lives. */
export function startupFile(conversation, home = os.homedir()) {
  if (!CONVERSATION_ID.test(conversation)) {
    throw new Error(`invalid conversation id ${JSON.stringify(conversation)}`);
  }
  return path.join(startupDir(home), `${conversation}.json`);
}

/** Reads a startup record, or null. */
export function readStartupRecord(conversation, home = os.homedir()) {
  return readJson(startupFile(conversation, home));
}

/** Marks a conversation's vibe or fleet session as started with the check not yet run; keeps any record it already has. */
export function markPending(conversation, home = os.homedir(), now = new Date()) {
  const file = startupFile(conversation, home);
  if (existsSync(file)) {
    return readJson(file);
  }
  const record = { conversation, status: VersionStatus.Pending, startedAt: now.toISOString() };
  writeJson(file, record);
  return record;
}

/** Why the recorded state blocks starting work, or null: the check never ran, or it found an outdated plugin nobody chose about. */
export function blockingProblem(record) {
  if (record?.status === VersionStatus.Pending) {
    return "the plugin version check has not run in this conversation";
  }
  if (record?.status === VersionStatus.Outdated && !record.choice) {
    return `plugins are outdated (${record.versions}) and the person has not chosen to update or to proceed`;
  }
  if (record?.loadedSkillRequired === true && !record.loadedSkill?.actorId) {
    return "this conversation's hooks recorded no load of the current vibe/fleet skill; load it with the Skill tool or its start prompt before continuing";
  }
  return loadedSkillProblem(record);
}

export function startupDir(home) {
  return path.join(home, ".codex", "vibe", "plugin-version");
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}
