import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { requirePrototypePublication } from "../../../plugins/vibe/skills/vibe/scripts/prototype-session.mjs";
import { readInput } from "./contracts.js";
import { verifyExternalCi } from "./main-sync-ci.js";
import { isPublisherContext } from "./record-context.js";
import { committedInputs, executeChecks, checkRecipe } from "./main-sync-checks.js";
import { MainSyncError, mainSyncInputSchema, mainSyncReceiptSchema, type MainSyncReceipt } from "./main-sync-contracts.js";
import { digest, requireSyncReceipt, saveSyncReceipt, syncContext, syncLocation, readPrivateJson, MAIN_SYNC_FILE } from "./main-sync-state.js";

const GIT_NETWORK_MS = 15 * 60 * 1000;
const desktopSchema = z.object({ ok: z.boolean(), running: z.boolean() }).passthrough();
const TEST_HISTORY_PATH = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\.snap$|(?:^|\/)(?:__tests__|__fixtures__|__snapshots__|e2e)\/|^apps\/desktop\/test\/)/;
export { MainSyncError };

/** Reuses bounded stdin input rather than source authority or success claims supplied in argv/task text. */
export async function readMainSyncInput(worktree: string) {
  const input = mainSyncInputSchema.parse(await readInput());
  if (realpathSync(input.context.worktree) !== realpathSync(worktree)) throw new MainSyncError("CLI worktree and owned operation context differ");
  return input;
}

/** Captures fresh main once, then stages an ordinary merge; this operation never commits or pushes. */
export function prepareMainSync(raw: unknown) {
  const value = syncContext(raw, "prepare");
  const root = value.place.root;
  committedInputs(root);
  const previousFile = join(value.place.dir, MAIN_SYNC_FILE);
  const previous = existsSync(previousFile) ? mainSyncReceiptSchema.parse(readPrivateJson(previousFile)) : undefined;
  if (previous && (previous.worktree !== root || previous.branch !== value.place.branch
    || previous.originalBase !== value.place.session.baseCommit || previous.operator.id !== value.place.session.operator.id
    || previous.operator.email !== value.place.session.operator.email)) {
    throw new MainSyncError("Previous main-sync provenance belongs to another session; preserve it and inspect the owned evidence");
  }
  const desktopScript = fileURLToPath(new URL("../vibe-sessions.mjs", import.meta.url));
  const desktop = spawnSync(process.execPath, [desktopScript, "desktop-tab", "--worktree", root], {
    encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (desktop.error || desktop.status !== 0) throw new MainSyncError("Could not verify the owned Desktop before changing its source");
  if (desktopSchema.parse(JSON.parse(desktop.stdout)).running) throw new MainSyncError("Stop only this session's owned Desktop before main-sync", "NEEDS_DESKTOP_STOP");
  try { git(root, ["fetch", "origin", "main"], { timeout: GIT_NETWORK_MS }); }
  catch { throw new MainSyncError("Fresh main fetch failed; nothing was published"); }
  const mainSha = git(root, ["rev-parse", "FETCH_HEAD^{commit}"]);
  const startingHead = git(root, ["rev-parse", "HEAD"]);
  const common = git(root, ["merge-base", startingHead, mainSha]);
  const importedFiles = git(root, ["diff", "--name-status", "--no-renames", common, mainSha]).split("\n").filter(Boolean)
    .map((line) => { const tab = line.indexOf("\t"); return { status: line.slice(0, tab), path: line.slice(tab + 1) }; });
  const validationSince = value.place.session.vercel?.lastDeployedCommit
    ?? value.place.session.prototype?.deployedCommit ?? value.place.session.baseCommit;
  git(root, ["cat-file", "-e", `${validationSince}^{commit}`]);
  const receipt: MainSyncReceipt = { version: 1, transactionId: randomUUID(), worktree: root,
    branch: value.place.branch, operator: { id: value.place.session.operator.id, email: value.place.session.operator.email },
    purpose: value.purpose, mainSha, startingHead, originalBase: value.place.session.baseCommit,
    validationSince, fetchedAt: new Date().toISOString(), importedFiles,
    importedCommits: [...new Set([...(previous?.importedCommits ?? []),
      ...git(root, ["rev-list", `${common}..${mainSha}`]).split("\n").filter(Boolean)])],
    featureTestHistory: featureTestHistory(root, value.place.session.baseCommit, startingHead, previous), requestContinuations: [] };
  saveSyncReceipt(value.place.dir, receipt);
  if (!isAncestor(root, mainSha)) {
    try { git(root, ["merge", "--no-commit", "--no-ff", mainSha], { timeout: GIT_NETWORK_MS }); }
    catch {
      const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]);
      throw new MainSyncError(`Ordinary main merge needs the SAME writer's conflict/source correction${conflicts ? `: ${conflicts}` : ""}; ROOT alone commits`, "NEEDS_CHANGE");
    }
  }
  const requiresCommit = existsSync(join(value.place.dir, "MERGE_HEAD"));
  return { status: requiresCommit ? "NEEDS_COMMIT" : "DONE", transactionId: receipt.transactionId,
    mainSha, headSha: git(root, ["rev-parse", "HEAD"]), requiresCommit, importedFiles };
}

/** Only the same active source writer executes checks and creates the exact committed-result receipt. */
export function validateMainSync(raw: unknown) {
  const value = syncContext(raw, "validate");
  const receipt = requireSyncReceipt(value);
  if (!isAncestor(value.place.root, receipt.mainSha)) throw new MainSyncError("Captured main is not merged into the result", "NEEDS_CHANGE");
  const identity = committedInputs(value.place.root);
  let validation = receipt.validation;
  if (!value.context.mainSyncCiRun || !validation || !validationMatches(value, receipt, identity)) {
    validation = executeChecks(value, receipt);
  }
  let ciEvidence = receipt.ciEvidence;
  if (ciEvidence && (ciEvidence.checkoutSha !== identity.headSha || ciEvidence.treeSha !== identity.treeSha
    || ciEvidence.inputSha256 !== identity.inputSha256)) ciEvidence = undefined;
  if (value.context.mainSyncCiRun) {
    if (remoteHead(value.place.root, value.place.branch) !== identity.headSha
      || (receipt.pushedHead !== identity.headSha && !alreadyPublished(value.place.session, identity.headSha))) {
      throw new MainSyncError("Exact handoff snapshot must be safely published before external coverage completion");
    }
    if (validation.e2eLimitations.some((item) => item.argv[1] !== "--dir" || item.argv[2] !== "apps/desktop")) {
      throw new MainSyncError("Selected required E2E has no verified external checked-source interface; handoff remains incomplete");
    }
    ciEvidence = verifyExternalCi(value, identity);
  }
  const after = committedInputs(value.place.root);
  if (after.headSha !== identity.headSha || after.treeSha !== identity.treeSha || after.inputSha256 !== identity.inputSha256) {
    throw new MainSyncError("Source changed during actual CI verification; no handoff completion was issued", "NEEDS_CHANGE");
  }
  // Recheck the current source owner too: a stopped turn cannot issue a late success receipt.
  syncContext(raw, "validate");
  const next = { ...receipt, validation, ...(ciEvidence ? { ciEvidence } : {}) };
  if (!ciEvidence) delete next.ciEvidence;
  if (receipt.pushedHead !== identity.headSha) delete next.pushedHead;
  saveSyncReceipt(value.place.dir, next);
  const requiredE2eComplete = validation.e2eLimitations.length === 0 || Boolean(ciEvidence);
  return { status: value.purpose === "handoff" && !requiredE2eComplete ? "NEEDS_REVIEW" : "DONE",
    publicationReady: true, requiredE2eComplete, transactionId: receipt.transactionId, mainSha: receipt.mainSha,
    headSha: validation.headSha, treeSha: validation.treeSha, commandCount: validation.commands.length,
    purpose: value.purpose, validationScope: "publication-preparation", e2eLimitations: validation.e2eLimitations,
    ...(ciEvidence ? { ciEvidence } : {}) };
}

/** Pushes only the explicit admitted commit through normal hooks; it never force-pushes or commits. */
export function pushMainSync(raw: unknown) {
  const { value, receipt, identity } = admitted(raw, "push");
  const consumed = consumePublication(value, receipt);
  if (alreadyPublished(value.place.session, identity.headSha) && remoteHead(value.place.root, value.place.branch) === identity.headSha) {
    return { status: "DONE", pushed: false, alreadyPublished: true, transactionId: receipt.transactionId,
      headSha: identity.headSha, mainSha: receipt.mainSha };
  }
  try { git(value.place.root, ["push", "-u", "origin", `${identity.headSha}:refs/heads/${value.place.branch}`], { timeout: GIT_NETWORK_MS }); }
  catch { throw new MainSyncError("Normal pre-push/push refused the exact validated result; nothing was requested"); }
  const current = committedInputs(value.place.root);
  if (current.headSha !== identity.headSha || current.inputSha256 !== identity.inputSha256) {
    throw new MainSyncError("Source changed during push; the validated commit was pushed but no current environment request is authorized", "NEEDS_CHANGE");
  }
  syncContext(raw, "push");
  saveSyncReceipt(value.place.dir, { ...consumed, pushedHead: identity.headSha });
  return { status: "DONE", pushed: true, alreadyPublished: false, transactionId: receipt.transactionId,
    headSha: identity.headSha, mainSha: receipt.mainSha };
}

/** Distinct request-only flags/Desktop grants consume matching state; they never acquire publisher rights. */
export function admitMainSyncRequest(raw: unknown) {
  const { value, receipt, identity } = admitted(raw, "request");
  if (remoteHead(value.place.root, value.place.branch) !== identity.headSha
    || (receipt.pushedHead !== identity.headSha && !alreadyPublished(value.place.session, identity.headSha))) {
    throw new MainSyncError("Canonical redeploy required before this request-only action: validated result is not published", "NEEDS_CHANGE");
  }
  const publisher = isPublisherContext({ ...value.context, exclusiveRecordTurn: true });
  if (publisher) consumePublication(value, receipt);
  else consumeRequestContinuation(value, receipt);
  return { transactionId: receipt.transactionId, headSha: identity.headSha, mainSha: receipt.mainSha,
    alreadyPublished: publisher && value.purpose === "handoff" && alreadyPublished(value.place.session, identity.headSha) };
}

/** Canonical prototype sharing consumes the same proof without inventing an app environment or alias. */
export function admitMainSyncShare(raw: unknown) {
  const { value, receipt, identity } = admitted(raw, "share");
  if (!value.place.branch.startsWith("prototype/")) throw new MainSyncError("Canonical share requires an owned prototype branch");
  consumePublication(value, receipt);
  return { transactionId: receipt.transactionId, headSha: identity.headSha, mainSha: receipt.mainSha,
    alreadyPublished: alreadyPublished(value.place.session, identity.headSha) && remoteHead(value.place.root, value.place.branch) === identity.headSha };
}

/** Read-only inventory uses the captured main, never a later tracking-ref value masquerading as its sync base. */
export function readMainSyncProvenance(worktree: string) {
  const place = syncLocation(worktree);
  const file = join(place.dir, MAIN_SYNC_FILE);
  if (!existsSync(file)) return undefined;
  const value = mainSyncReceiptSchema.parse(readPrivateJson(file));
  if (value.worktree !== place.root || value.branch !== place.branch || value.originalBase !== place.session.baseCommit
    || value.operator.id !== place.session.operator.id || value.operator.email !== place.session.operator.email) return undefined;
  const merge = join(place.dir, "MERGE_HEAD");
  const pendingMerge = existsSync(merge) && git(place.root, ["rev-parse", "MERGE_HEAD"]) === value.mainSha;
  if (!pendingMerge && !isAncestor(place.root, value.mainSha)) return undefined;
  return { mainSha: value.mainSha, originalBase: value.originalBase, importedFiles: value.importedFiles,
    featureTestHistory: value.featureTestHistory, transactionId: value.transactionId, pendingMerge };
}

/** Existing worker outcomes remain compact and never echo a command log, task text or secret. */
export function mainSyncFailure(error: unknown) {
  if (error instanceof MainSyncError) return { status: error.status, error: error.message };
  return { status: "BLOCKED", error: "Main-sync context or private evidence is invalid; preserve the operation and inspect its owned evidence" };
}

function admitted(raw: unknown, operation: "push" | "request" | "share") {
  const value = syncContext(raw, operation);
  const receipt = requireSyncReceipt(value);
  if (receipt.publicationTurn && (operation !== "request" || isPublisherContext({ ...value.context, exclusiveRecordTurn: true }))
    && JSON.stringify(receipt.publicationTurn) !== JSON.stringify(publicationTurn(value))) {
    throw new MainSyncError("Canonical redeploy requires fresh preparation for this distinct publication turn", "NEEDS_CHANGE");
  }
  const identity = committedInputs(value.place.root);
  if (!validationMatches(value, receipt, identity)) {
    throw new MainSyncError("Canonical redeploy required: exact committed validation proof is missing or stale", "NEEDS_CHANGE");
  }
  return { value, receipt, identity };
}

function validationMatches(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt,
  identity: ReturnType<typeof committedInputs>) {
  const proof = receipt.validation;
  if (!proof || proof.headSha !== identity.headSha || proof.treeSha !== identity.treeSha
    || proof.inputSha256 !== identity.inputSha256 || !isAncestor(value.place.root, receipt.mainSha)) {
    return false;
  }
  const expected = checkRecipe(value, receipt);
  const commandIdentity = (item: { argv: string[]; bindings?: Record<string, string>; cwd?: string }) => ({ argv: item.argv,
    ...(item.bindings ? { bindings: item.bindings } : {}), ...(item.cwd ? { cwd: item.cwd } : {}) });
  if (JSON.stringify(expected.commands.map(commandIdentity)) !== JSON.stringify(proof.commands.map(commandIdentity))
    || JSON.stringify(expected.e2eLimitations) !== JSON.stringify(proof.e2eLimitations)) {
    return false;
  }
  for (const [index, command] of proof.commands.entries()) {
    const file = join(value.place.dir, `vibe-main-sync-${receipt.transactionId}-${index}.log`);
    const stat = lstatSync(file);
    if (command.log !== file || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024
      || digest(readFileSync(file)) !== command.sha256) throw new MainSyncError("Actual command evidence changed; validation is required", "NEEDS_CHANGE");
  }
  return true;
}

function publicationTurn(value: ReturnType<typeof syncContext>) {
  const { runtime, workerId, requestId, lease } = value.context;
  return { runtime, workerId, requestId, lease };
}

function consumePublication(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt) {
  const consumed = { ...receipt, publicationTurn: publicationTurn(value),
    requestContinuations: receipt.publicationTurn ? receipt.requestContinuations : value.context.mainSyncRequestContinuations ?? [] };
  saveSyncReceipt(value.place.dir, consumed);
  return consumed;
}

function consumeRequestContinuation(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt) {
  const index = receipt.requestContinuations.findIndex((intent) => intent.runtime === value.context.runtime
    && intent.requestId === value.context.requestId && intent.recordAction === value.context.recordAction);
  const intent = receipt.requestContinuations[index];
  const turn = publicationTurn(value);
  if (!receipt.publicationTurn || !intent || (intent.turn && JSON.stringify(intent.turn) !== JSON.stringify(turn))) {
    throw new MainSyncError("Canonical redeploy requires fresh preparation: no parent-authorized current-operation continuation", "NEEDS_CHANGE");
  }
  const continuations = [...receipt.requestContinuations];
  continuations[index] = { ...intent, turn };
  saveSyncReceipt(value.place.dir, { ...receipt, requestContinuations: continuations });
}

function isAncestor(root: string, commit: string) {
  try { git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]); return true; }
  catch { return false; }
}
function remoteHead(root: string, branch: string) {
  try { return git(root, ["ls-remote", "origin", `refs/heads/${branch}`], { timeout: GIT_NETWORK_MS }).split("\t")[0] ?? ""; }
  catch { throw new MainSyncError("Could not verify the exact remote branch result"); }
}
function alreadyPublished(session: ReturnType<typeof syncLocation>["session"], head: string) {
  if (session.branch.startsWith("prototype/")) {
    try { return requirePrototypePublication(session, head).deployedCommit === head; }
    catch { return false; }
  }
  return session.vercel?.lastDeployedCommit === head && Boolean(session.vercel.verifiedAt && session.vercel.verifiedRequestId)
    && (!session.lastRequestId || session.lastRequestId === session.vercel.verifiedRequestId);
}

function featureTestHistory(root: string, originalBase: string, startingHead: string, previous?: MainSyncReceipt) {
  const entries = new Map((previous?.featureTestHistory ?? []).map((entry) => [`${entry.commit}:${entry.path}`, entry]));
  const knownImports = new Set(previous?.importedCommits ?? []);
  const commits = git(root, ["rev-list", "--first-parent", `${originalBase}..${startingHead}`]).split("\n").filter(Boolean);
  for (const commit of commits) {
    if (knownImports.has(commit)) continue;
    const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
    const paths = git(root, ["diff", "--name-only", parents[0]!, commit]).split("\n").filter(Boolean);
    for (const path of paths) {
      if (!TEST_HISTORY_PATH.test(path)) continue;
      // Exact non-first-parent adoption is import; a newly combined assertion remains feature evidence.
      const result = git(root, ["ls-tree", commit, "--", path]);
      if (parents.slice(1).some((parent) => git(root, ["ls-tree", parent, "--", path]) === result)) continue;
      entries.set(`${commit}:${path}`, { commit, path });
    }
  }
  return [...entries.values()].sort((left, right) => left.commit.localeCompare(right.commit) || left.path.localeCompare(right.path));
}
