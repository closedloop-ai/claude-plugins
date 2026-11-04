import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';
import { dockerResult, dockerRun, markPending, OWNERSHIP_VERSION as VERSION, refreshMarker, writeAtomic } from './owned-state.mjs';
import { recordBuiltTags, removeOwnedCache, removeOwnedRunState, removeRunOwnedBuilder,
  verifiedBuilder, verifyOwnedCache, verifyOwnedRunState } from './owned-builder.mjs';

/** Reserve private service tags; only the child shim's selected waves can create them. */
export function plannedLocalTags(docker, project, worktree, command, args = [], env = process.env) {
  if (args.includes('--no-build') || ![command, ...args].some((word) => /(?:^|\/)run-containerized\.sh$/.test(word))) return [];
  const composeArgs = ["compose", "-p", project, "-f", path.join(worktree, "e2e", "compose.yml")];
  const ghcr = env.E2E_GHCR_CONTENT_IMAGES === "1";
  if (ghcr) composeArgs.push("-f", path.join(worktree, "e2e", "compose.ghcr.yml"));
  composeArgs.push("--profile", "*", "config", "--format", "json");
  const result = spawnSync(docker, composeArgs, { encoding: "utf8", timeout: 30_000, env });
  if (result.error || result.status !== 0) throw new Error("Could not resolve local E2E build tags.");
  const services = JSON.parse(result.stdout).services;
  if (!services || typeof services !== "object") throw new Error("Resolved Compose services are missing.");
  return Object.entries(services).filter(([, service]) => service.build)
    .map(([name]) => project + "-" + name);
}

const DOCKER_KINDS = Object.freeze([
  { key: "containers", noun: "container", list: ["container", "ls", "-aq", "--no-trunc"], remove: ["container", "rm", "-f"] },
  { key: "volumes", noun: "volume", list: ["volume", "ls", "-q"], remove: ["volume", "rm"] },
  { key: "networks", noun: "network", list: ["network", "ls", "--no-trunc", "-q"], remove: ["network", "rm"] },
]);

function dockerRunner(args) {
  return spawnSync(process.env.VIBE_E2E_DOCKER || "docker", args, { encoding: "utf8", timeout: 30_000 });
}

function dockerOutput(args, run, { missing = false } = {}) {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr ?? "").trim();
    const id = args.at(-1);
    const notFound = {
      container: `Error response from daemon: No such container: ${id}`,
      volume: `Error response from daemon: get ${id}: no such volume`,
      network: `Error response from daemon: network ${id} not found`,
    }[args[0]];
    if (missing && result.status === 1 && message === notFound) return null;
    throw new Error(`Docker ${args[0]} ${args[1]} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return String(result.stdout ?? "").trim();
}

function resourceWitness(kind, id, run) {
  if (kind.key === "containers" && !/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker container needs a full container ID.");
  const raw = dockerOutput([kind.noun, "inspect", id], run, { missing: true });
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  const value = Array.isArray(parsed) ? parsed[0] : null;
  const labels = kind.key === "containers" ? value?.Config?.Labels : value?.Labels;
  const created = value?.Created ?? value?.CreatedAt;
  const identity = kind.key === "volumes" ? value?.Name : value?.Id;
  if (identity !== id) throw new Error(`Docker ${kind.noun} ${id} resolved ID changed identity.`);
  if (typeof created !== "string" || !Number.isFinite(Date.parse(created))) {
    throw new Error(`Docker ${kind.noun} ${id} has no parseable creation witness.`);
  }
  const project = labels?.["com.docker.compose.project"];
  if (typeof project !== "string" || !project) throw new Error(`Docker ${kind.noun} ${id} has no project ownership label.`);
  const ownerToken = labels?.["vibe.owner-token"];
  return { id: identity, created, project, ...(typeof ownerToken === "string" ? { ownerToken } : {}) };
}

/** Capture exact Docker identities, including stopped containers, before later cleanup. */
export function captureOwnedDockerResources({ project = null, containers, volumes, networks }, { run = dockerRunner } = {}) {
  if (project !== null && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("Invalid recorded Compose project.");
  const record = { project, containers: [], volumes: [], networks: [] };
  for (const kind of DOCKER_KINDS) {
    const ids = { containers, volumes, networks }[kind.key] ?? (project
      ? dockerOutput([...kind.list, "--filter", `label=com.docker.compose.project=${project}`], run).split("\n").filter(Boolean)
      : []);
    for (const id of ids) {
      const witness = resourceWitness(kind, id, run);
      if (!witness || (project && witness.project !== project)) throw new Error(`Docker ${kind.noun} ${id} is not in the recorded project.`);
      record[kind.key].push(witness);
    }
  }
  return record;
}

/** Remove only resources whose exact ID, creation witness and project still match the record. */
export function removeOwnedDockerResources(record, { run = dockerRunner } = {}) {
  const targets = [];
  if (record?.project) {
    const currentProject = captureOwnedDockerResources({ project: record.project }, { run });
    for (const kind of DOCKER_KINDS) {
      const recorded = new Set((record[kind.key] ?? []).map((entry) => entry.id));
      if (currentProject[kind.key].some((entry) => !recorded.has(entry.id))) {
        throw new Error(`Docker ${kind.noun} in the project was not recorded; cleanup refused.`);
      }
    }
  }
  for (const kind of DOCKER_KINDS) {
    for (const saved of record?.[kind.key] ?? []) {
      if (!saved?.id || typeof saved?.created !== "string" || !Number.isFinite(Date.parse(saved.created))
        || typeof saved?.project !== "string" || !saved.project) {
        throw new Error(`Unrecorded Docker ${kind.noun} has no exact creation witness and project ownership.`);
      }
      const current = resourceWitness(kind, saved.id, run);
      if (current && (current.id !== saved.id || current.created !== saved.created || current.project !== saved.project
        || (record.project && current.project !== record.project)
        || (saved.ownerToken && current.ownerToken !== saved.ownerToken))) {
        throw new Error(`Docker ${kind.noun} ${saved.id} changed identity; left alone.`);
      }
      if (current) targets.push({ kind, saved });
    }
  }
  for (const { kind, saved } of targets) {
    dockerOutput([...kind.remove, saved.id], run);
    if (resourceWitness(kind, saved.id, run)) throw new Error(`Docker ${kind.noun} ${saved.id} remains after cleanup.`);
  }
  return { removed: targets.map(({ kind, saved }) => ({ kind: kind.noun, id: saved.id })) };
}


function sameImageTag(saved, actual) {
  const normalized = saved.includes(':') && saved.lastIndexOf(':') > saved.lastIndexOf('/') ? saved : saved + ':latest';
  return actual === saved || actual === normalized;
}

function imageWitness(tag, run) {
  const result = run(['image', 'inspect', tag]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const failure = String(result.stderr ?? '').trim();
    const missing = 'Error response from daemon: No such image: ';
    if (result.status === 1 && failure.startsWith(missing) && sameImageTag(tag, failure.slice(missing.length))) return null;
    throw new Error(`Docker image inspect failed: ${failure}`);
  }
  const image = JSON.parse(String(result.stdout ?? ''))[0];
  if (!/^sha256:[a-f0-9]{64}$/i.test(image?.Id ?? '') || !Number.isFinite(Date.parse(image?.Created ?? ''))
    || !Array.isArray(image.RepoTags) || !image.RepoTags.some((value) => sameImageTag(tag, value))) {
    throw new Error('Image tag has no exact ID, creation or tag witness');
  }
  return { tag, id: image.Id, created: image.Created, tags: image.RepoTags };
}

function projectResources(project, run) {
  return captureOwnedDockerResources({ project }, { run });
}

function projectHasRunningContainers(resources, run) {
  for (const witness of resources.containers) {
    const value = JSON.parse(dockerResult(['container', 'inspect', witness.id], run))[0];
    if (typeof value?.State?.Running !== 'boolean' || value.State.Running) {
      throw new Error('E2E project container is running or has unreadable state');
    }
  }
}

function resourceCount(resources) {
  return resources.containers.length + resources.volumes.length + resources.networks.length;
}

/** Reserve an empty full-token Compose project and absent exact local tags before launching a creator. */
export function reserveGeneratedE2E({ token, project, owner, startedAt, plannedTags = [], file },
  { run = dockerRun, home } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(token ?? '') || project !== `vibe-e2e-${token}`
    || !Number.isFinite(Date.parse(startedAt ?? '')) || !owner?.identity
    || typeof owner.token !== 'string' || owner.token.replace(/-/g, '') !== token || !file) {
    throw new Error('Generated E2E reservation needs a full random project, owner and creation time');
  }
  if (new Set(plannedTags).size !== plannedTags.length
    || plannedTags.some((tag) => !tag.startsWith(project + '-'))) {
    throw new Error('Only distinct private project image tags may be reserved');
  }
  if (resourceCount(projectResources(project, run))) throw new Error('Generated Compose project is not empty before launch');
  for (const tag of plannedTags) if (imageWitness(tag, run)) throw new Error(`Planned image tag already exists: ${tag}`);
  const record = { version: VERSION, kind: 'e2e', state: 'reserved', token, project, owner, startedAt,
    plannedTags, absentAtReservation: true, launchPending: false, images: [], file };
  if (home) markPending(home);
  writeAtomic(file, record);
  if (home) refreshMarker(home);
  return record;
}

/** Persist the spawned command's birth identity before it can outlive the wrapper. */
export function recordE2EChild(record, pid) {
  if (record?.kind !== 'e2e' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('E2E child PID is unreadable');
  const identity = readProcessIdentity(pid);
  if (!identity) throw new Error('E2E child birth identity is unreadable');
  record.child = { pid, pgid: pid, identity, startedAt: new Date().toISOString() };
  if (record.file) writeAtomic(record.file, record);
  return record.child;
}

function defaultChildAlive(child) {
  if (!child) return false;
  if (child.pgid !== undefined) {
    if (!Number.isSafeInteger(child.pgid) || child.pgid <= 1) return true;
    // The gate and every non-detached descendant share this isolated group.
    // A reused group ID may delay cleanup, but can never authorize deletion.
    try { process.kill(-child.pgid, 0); return true; }
    catch (error) { if (error?.code === 'EPERM') return true; if (error?.code !== 'ESRCH') return true; }
  }
  const identity = readProcessIdentity(child.pid);
  if (identity) return !child.identity || identity === child.identity;
  try { process.kill(child.pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function inspectContainersForImage(image, project, run) {
  const ids = dockerResult(['container', 'ls', '-aq', '--no-trunc'], run).split('\n').filter(Boolean);
  for (const id of ids) {
    const raw = dockerResult(['container', 'inspect', id], run);
    const container = JSON.parse(raw)[0];
    if (container?.Image !== image.id) continue;
    if (container.Config?.Labels?.['com.docker.compose.project'] !== project || container.State?.Running === true) {
      throw new Error(`Image ${image.tag} is referenced by a foreign or live container`);
    }
  }
}

/** Reconcile only post-reservation project witnesses and exact built tags; partial retries stay idempotent. */
export function reconcileGeneratedE2E(record, { run = dockerRun, ownerAlive = () => false, childAlive = defaultChildAlive,
  lockHeld = () => false,
  allowCurrentOwner = false, home } = {}) {
  if (record?.version !== VERSION || record.kind !== 'e2e' || !/^[a-f0-9]{32}$/i.test(record.token ?? '')
    || record.project !== `vibe-e2e-${record.token}` || record.absentAtReservation !== true
    || !Number.isFinite(Date.parse(record.startedAt ?? '')) || !record.owner?.identity
    || !Array.isArray(record.plannedTags) || typeof record.launchPending !== 'boolean') {
    throw new Error('Legacy E2E reservation has no exact ownership proof');
  }
  if (record.state === 'complete') return { removed: [] };
  if (!allowCurrentOwner && (ownerAlive(record.owner) || lockHeld(record.owner))) throw new Error('Live E2E owner or lock retains resources');
  if (record.launchPending && !record.child) {
    // No release file could have been written before the birth witness. A
    // stranded gate times out without starting the command.
    if (!record.file || existsSync(path.join(path.dirname(record.file), `e2e-gate-${record.token}.ready`))) {
      throw new Error('E2E launch handshake is unproved');
    }
  }
  if (childAlive(record.child)) throw new Error('Live E2E command tree retains resources');
  const current = projectResources(record.project, run);
  projectHasRunningContainers(current, run);
  for (const kind of ['containers', 'volumes', 'networks']) {
    for (const witness of current[kind]) {
      if (Date.parse(witness.created) <= Date.parse(record.startedAt)) throw new Error('Docker resource predates the reserved project');
    }
  }
  if (record.resources) {
    for (const kind of ['containers', 'volumes', 'networks']) {
      const saved = new Map((record.resources[kind] ?? []).map((value) => [value.id, value]));
      for (const witness of current[kind]) {
        const previous = saved.get(witness.id);
        if (!previous || previous.created !== witness.created || previous.project !== witness.project) {
          throw new Error('Docker project gained an unrecorded or changed witness');
        }
      }
    }
  }
  const images = [];
  if (record.builder?.builtTagsFile) recordBuiltTags(record);
  if (record.builder && record.state !== 'cleaning') {
    for (const tag of record.requiredBuiltTags ?? []) {
      if (!imageWitness(tag, run)) throw new Error('Built service tag is missing from the local image store');
    }
  }
  const isPrivateTag = (tag) => typeof tag === 'string' && tag.startsWith(record.project + '-')
    && /^[a-z0-9][a-z0-9_-]*$/.test(tag.slice(record.project.length + 1));
  for (const tag of record.plannedTags) {
    const currentImage = imageWitness(tag, run);
    if (!currentImage) continue;
    // Compose up can implicitly build a reserved project-private service tag.
    // The full random project and pre-launch absence are the capability;
    // successful explicit build waves still add stronger ID/Created witnesses.
    if (!isPrivateTag(tag)) throw new Error('Image tag is outside the reserved private project');
    if (Date.parse(currentImage.created) <= Date.parse(record.startedAt)) throw new Error('Image tag predates the reservation');
    const previous = record.images?.find((image) => image.tag === tag);
    if (previous && (previous.id !== currentImage.id || previous.created !== currentImage.created)) {
      throw new Error('Image tag changed ID or creation witness');
    }
    const built = record.observedImages?.find((image) => image.tag === tag);
    if (built && (built.id !== currentImage.id || built.created !== currentImage.created)) {
      throw new Error('Built image tag changed its wave witness');
    }
    for (const other of currentImage.tags) {
      const owned = record.plannedTags.find((candidate) => sameImageTag(candidate, other));
      if (!owned || !isPrivateTag(owned)) throw new Error('Image is retagged or shared');
      const peer = imageWitness(owned, run);
      if (!peer || peer.id !== currentImage.id || peer.created !== currentImage.created) {
        throw new Error('Owned image pair has differing witnesses');
      }
      const peerBuilt = record.observedImages?.find((image) => image.tag === owned);
      if (peerBuilt && (peerBuilt.id !== peer.id || peerBuilt.created !== peer.created)) {
        throw new Error('Owned image pair changed its wave witness');
      }
    }
    inspectContainersForImage(currentImage, record.project, run);
    images.push(currentImage);
  }
  if (record.builder) verifiedBuilder(record, run);
  if (record.cache) verifyOwnedCache(record);
  if (record.runState) verifyOwnedRunState(record);
  // Freeze the complete discovery before deleting anything. The existing
  // removal primitive re-lists the project and refuses additions after freeze.
  record.resources ??= current;
  record.images = images;
  record.state = 'cleaning';
  if (record.file) writeAtomic(record.file, record);
  const removed = removeOwnedDockerResources(record.resources, { run }).removed;
  record.cleanupStage = 'resources';
  if (record.file) writeAtomic(record.file, record);
  for (const image of images) {
    const still = imageWitness(image.tag, run);
    if (!still) continue;
    if (still.id !== image.id || still.created !== image.created) throw new Error('Image tag changed during cleanup');
    inspectContainersForImage(still, record.project, run);
    dockerResult(['image', 'rm', image.tag], run);
    if (imageWitness(image.tag, run)) throw new Error('Owned image tag remains after cleanup');
    removed.push({ kind: 'image-tag', id: image.tag });
  }
  record.cleanupStage = 'tags';
  if (record.file) writeAtomic(record.file, record);
  removeRunOwnedBuilder(record, run);
  record.cleanupStage = 'builder';
  if (record.file) writeAtomic(record.file, record);
  removeOwnedCache(record);
  record.cleanupStage = 'cache';
  if (record.file) writeAtomic(record.file, record);
  removeOwnedRunState(record);
  record.cleanupStage = 'run-state';
  if (record.file) writeAtomic(record.file, record);
  if (record.file) rmSync(path.join(path.dirname(record.file), `e2e-gate-${record.token}.ready`), { force: true });
  record.state = 'complete';
  if (record.file) writeAtomic(record.file, record);
  if (home) refreshMarker(home);
  return { removed };
}
