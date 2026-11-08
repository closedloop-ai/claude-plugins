#!/usr/bin/env node
// Usage: node fleet-remote-evidence.mjs journal <launch-journal> <state> <claim> <attempt>
//        node fleet-remote-evidence.mjs preflight-begin|preflight-launch <claim> <attempt> <pid>
//        node fleet-remote-evidence.mjs preflight-probe <claim> <attempt> <state> <launch-journal>
// A prepared journal proves no App Server request only after its exact launcher has ended.
import { linkSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcessIdentity, readProcessStart } from '../../../shared/process-identity.mjs';

function pathAbsent(target) {
  try { lstatSync(target); return false; } catch (error) { return error?.code === 'ENOENT'; }
}

/** A dead process cannot advance again; re-read all durable evidence after proving death. */
function postDeathAbsent(statePath, journalPath) {
  return pathAbsent(statePath) && pathAbsent(journalPath);
}

/** Classify a prepared launch journal using the exact remote process birth witness. */
function preparedLauncherEvidence(journalPath, statePath, claimPath, attempt, { identityOf = readProcessIdentity, signal = process.kill } = {}) {
  try {
    const stat = lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'uncertain';
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (journal.phase !== 'prepared') return 'uncertain';
    const { pid, identity } = journal.launcher ?? {};
    if (!Number.isSafeInteger(pid) || pid <= 1 || typeof identity !== 'string' || !identity) return 'uncertain';
    let dead = false;
    try { signal(pid, 0); } catch (error) { if (error?.code !== 'ESRCH') return 'uncertain'; dead = true; }
    if (!dead) {
      const actual = identityOf(pid);
      if (!actual) return 'uncertain';
      if (actual === identity) return 'in-flight';
    }
    if (!pathAbsent(statePath)) return 'uncertain';
    const current = readClaim(journalPath);
    if (current?.phase !== 'prepared' || current.launcher?.pid !== pid || current.launcher.identity !== identity) return 'uncertain';
    const claim = readClaim(claimPath);
    if (!pathAbsent(claimPath) && (claim?.attempt !== attempt || claim.phase !== 'launching')) return 'uncertain';
    return 'prepared';
  } catch { return 'uncertain'; }
}

/** Read only complete regular claims; a missing or malformed witness never proves absence. */
function readClaim(claimPath) {
  try {
    const stat = lstatSync(claimPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(claimPath, 'utf8'));
  } catch { return null; }
}

function stagedWrite(target, value, { exclusive = false } = {}) {
  const stage = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(stage, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try {
    if (exclusive) linkSync(stage, target);
    else renameSync(stage, target);
  } finally {
    try { unlinkSync(stage); } catch { /* rename already consumed it */ }
  }
}

function beginPreflight(claimPath, attempt, pid) {
  const started = readProcessStart(pid);
  if (!started || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('remote preflight birth witness is unavailable');
  stagedWrite(claimPath, { attempt, phase: 'preflight', launcher: { pid, started } }, { exclusive: true });
}

function launchPreflight(claimPath, attempt, pid) {
  const claim = readClaim(claimPath);
  if (claim?.attempt !== attempt || claim.phase !== 'preflight' || claim.launcher?.pid !== pid
    || claim.launcher.started !== readProcessStart(pid)) throw new Error('remote preflight claim is not owned by this launcher');
  stagedWrite(claimPath, { ...claim, phase: 'launching' });
}

/** A missing claim is canceled with an exclusive link, so delayed preflight cannot start. */
function probePreflight(claimPath, attempt, statePath, journalPath) {
  let claim = readClaim(claimPath);
  if (!claim) {
    try {
      stagedWrite(claimPath, { attempt, phase: 'canceled' }, { exclusive: true });
      return postDeathAbsent(statePath, journalPath) ? 'preflight-dead' : 'uncertain';
    } catch (error) {
      if (error?.code !== 'EEXIST') return 'uncertain';
      claim = readClaim(claimPath);
    }
  }
  if (claim?.attempt !== attempt) return 'uncertain';
  if (claim.phase === 'canceled') return postDeathAbsent(statePath, journalPath) ? 'preflight-dead' : 'uncertain';
  if (!['preflight', 'launching'].includes(claim.phase)) return 'uncertain';
  const { pid, started } = claim.launcher ?? {};
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof started !== 'string' || !started) return 'uncertain';
  let dead = false;
  try { process.kill(pid, 0); } catch (error) { if (error?.code !== 'ESRCH') return 'uncertain'; dead = true; }
  if (!dead) {
    const actual = readProcessStart(pid);
    if (!actual) return 'uncertain';
    if (actual === started) return 'in-flight';
  }
  if (!postDeathAbsent(statePath, journalPath)) return 'uncertain';
  const current = readClaim(claimPath);
  if (current?.attempt !== attempt || current.phase !== claim.phase
    || current.launcher?.pid !== pid || current.launcher.started !== started) return 'uncertain';
  return 'preflight-dead';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, claimPath, attempt, pidText, journalPath] = process.argv;
  try {
    if (action === 'journal' && process.argv.length === 7) process.stdout.write(preparedLauncherEvidence(claimPath, attempt, pidText, journalPath));
    else if (action === 'preflight-begin' && process.argv.length === 6) beginPreflight(claimPath, attempt, Number(pidText));
    else if (action === 'preflight-launch' && process.argv.length === 6) launchPreflight(claimPath, attempt, Number(pidText));
    else if (action === 'preflight-probe' && process.argv.length === 7) process.stdout.write(probePreflight(claimPath, attempt, pidText, journalPath));
    else throw new Error('invalid fleet remote evidence command');
  } catch (error) {
    console.error(`fleet remote evidence: ${error.message}`);
    process.exitCode = 2;
  }
}
