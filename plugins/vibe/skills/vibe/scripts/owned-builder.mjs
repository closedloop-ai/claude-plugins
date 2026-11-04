import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupDir, dockerResult, dockerRun, writeAtomic } from './owned-state.mjs';

function inspectBuilderPart(kind, name, run) {
  const result = run([kind, 'inspect', name]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr ?? '').trim();
    const absent = kind === 'container' ? 'Error response from daemon: No such container: ' + name
      : 'Error response from daemon: get ' + name + ': no such volume';
    if (result.status === 1 && message === absent) return null;
    throw new Error('Builder ' + kind + ' inspect failed: ' + message);
  }
  const value = JSON.parse(String(result.stdout ?? ''))[0];
  const id = kind === 'container' ? value?.Id : value?.Name;
  const created = kind === 'container' ? value?.Created : value?.CreatedAt;
  if ((kind === 'container' && !/^[a-f0-9]{64}$/i.test(id ?? '')) || kind === 'volume' && id !== name
    || !Number.isFinite(Date.parse(created ?? ''))) throw new Error('Builder part has no exact identity witness');
  return { name, id, created };
}

export function verifiedBuilder(record, run) {
  const builder = record.builder;
  if (!builder?.name || builder.name !== 'vibe-build-' + record.token || builder.absentAtReservation !== true) {
    throw new Error('Builder has no run-owned reservation');
  }
  const container = inspectBuilderPart('container', builder.containerName, run);
  const volume = inspectBuilderPart('volume', builder.volumeName, run);
  if (!container && !volume) return null;
  if (!container || !volume || Date.parse(container.created) <= Date.parse(record.startedAt)
    || Date.parse(volume.created) <= Date.parse(record.startedAt)) throw new Error('Builder identity changed or predates run');
  if (builder.container && (builder.container.id !== container.id || builder.container.created !== container.created)
    || builder.volume && (builder.volume.id !== volume.id || builder.volume.created !== volume.created)) {
    throw new Error('Builder identity witness changed');
  }
  return { container, volume };
}

/** Create one activity-scoped builder and Turbo root without selecting Docker's global builder. */
export function prepareRunOwnedBuild(record, { run = dockerRun, home, buildIntent = true } = {}) {
  if (!buildIntent || record?.kind !== 'e2e' || !record.absentAtReservation
    || record.project !== 'vibe-e2e-' + record.token || !/^[a-f0-9]{32}$/i.test(record.token ?? '')
    || record.state !== 'reserved' || record.builder) throw new Error('Generated E2E build intent and an unused reservation are required');
  const version = dockerResult(['buildx', 'version'], run);
  const match = /v(\d+)\.(\d+)(?:\.|\b)/.exec(version);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 14) throw new Error('Buildx 0.14 or newer is required for default-load');
  if (!dockerResult(['compose', 'build', '--help'], run).includes('--builder')) throw new Error('Compose selected-builder support is required');
  const name = 'vibe-build-' + record.token;
  const containerName = 'buildx_buildkit_' + name + '0';
  const volumeName = containerName + '_state';
  if (inspectBuilderPart('container', containerName, run) || inspectBuilderPart('volume', volumeName, run)) {
    throw new Error('Per-run builder name or state already exists');
  }
  const root = path.join(home ? cleanupDir(home) : path.dirname(record.file), 'run-state', record.token);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  record.runState = { path: root, dev: rootStat.dev, ino: rootStat.ino };
  const config = path.join(root, 'buildkitd.toml');
  writeFileSync(config, 'debug = false\n[worker.oci]\ngc = true\nmax-parallelism = 1\n', { mode: 0o600, flag: 'wx' });
  const cachePath = path.join(root, 'turbo-cache');
  mkdirSync(cachePath, { mode: 0o700 });
  const cacheStat = lstatSync(cachePath);
  record.builder = { name, containerName, volumeName, absentAtReservation: true };
  record.cache = { path: cachePath, dev: cacheStat.dev, ino: cacheStat.ino };
  record.requiredBuiltTags ??= [];
  if (record.file) writeAtomic(record.file, record);
  const created = dockerResult(['buildx', 'create', '--driver', 'docker-container', '--driver-opt',
    'default-load=true', '--buildkitd-config', config, '--name', name, '--bootstrap'], run);
  if (created !== name) throw new Error('Buildx returned a different builder name');
  const parts = verifiedBuilder(record, run);
  if (!parts) throw new Error('Builder did not create its exact container and state volume');
  record.builder = { ...record.builder, ...parts };
  if (record.file) writeAtomic(record.file, record);
  return { builder: record.builder, cache: record.cache };
}

/** Existing Docker/Turbo child contracts, scoped to this one run only. */
export function ownedBuildEnvironment(record, env = process.env) {
  if (!record?.builder?.container || !record?.cache?.path) throw new Error('Owned build environment needs exact builder and cache witnesses');
  return { ...env, BUILDX_BUILDER: record.builder.name, TURBO_CACHE_DIR: record.cache.path,
    ...(record.builder.shimDir ? { PATH: record.builder.shimDir + path.delimiter + (env.PATH ?? '') } : {}) };
}

/** A child-only Docker adapter pins every Compose build wave with --builder. */
export function installOwnedBuildShim(record, dockerBinary) {
  if (!record?.builder?.container || !path.isAbsolute(dockerBinary)) throw new Error('Build shim needs an exact builder and Docker executable');
  const shimDir = path.join(path.dirname(record.cache.path), 'bin');
  mkdirSync(shimDir, { mode: 0o700 });
  const shim = path.join(shimDir, 'docker');
  const builtTagsFile = path.join(record.runState.path, 'built-tags.jsonl');
  const overlayFile = path.join(record.runState.path, 'owned-images.json');
  writeFileSync(overlayFile, JSON.stringify({ services: {} }), { mode: 0o600, flag: 'wx' });
  const source = '#!' + process.execPath + '\n' + `
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const docker=${JSON.stringify(dockerBinary)};
const overlayFile=${JSON.stringify(overlayFile)};
const observations=${JSON.stringify(builtTagsFile)};
const builder=${JSON.stringify(record.builder.name)};
const project=${JSON.stringify(record.project)};
const allowed=new Set(${JSON.stringify(record.plannedTags)});
const args=process.argv.slice(2);
const commands=new Set(['build','up','down','config','ps','images','logs','exec','run','stop','start','rm','pull']);
const index=args[0]==='compose'?args.findIndex((word,i)=>i>0&&commands.has(word)):-1;
let selected=[];
if(index>=0&&args[index]==='build'){
 const prefix=args.slice(0,index);
 const config=spawnSync(docker,[...prefix,'--profile','*','config','--format','json'],{encoding:'utf8',env:process.env});
 if(config.error||config.status!==0)process.exit(127);
 const services=JSON.parse(config.stdout).services;
 selected=args.slice(index+1).filter(name=>Object.hasOwn(services,name));
 if(!selected.length)process.exit(127);
 const overlay=JSON.parse(fs.readFileSync(overlayFile,'utf8'));
 for(const name of selected){
  if(!services[name].build)process.exit(127);
  const tag=project+'-'+name;
  if(!allowed.has(tag))process.exit(127);
  overlay.services[name]={image:tag};
  fs.appendFileSync(observations,JSON.stringify({phase:'planned',service:name,tag})+'\\n');
 }
 const tmp=overlayFile+'.'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(overlay),{mode:0o600,flag:'wx'});
 fs.renameSync(tmp,overlayFile);
}
if(index>=0)args.splice(index,0,'-f',overlayFile);
if(index>=0&&args[index+2]==='build')args.splice(index+3,0,'--builder',builder);
const result=spawnSync(docker,args,{stdio:'inherit',env:process.env});
if(result.error){process.stderr.write(result.error.message+'\\n');process.exit(127)}
if(selected.length){
 for(const name of selected){
  const tag=project+'-'+name;
  const inspected=spawnSync(docker,['image','inspect',tag],{encoding:'utf8',env:process.env});
  if(inspected.status!==0){
   if(result.status===0){fs.appendFileSync(observations,JSON.stringify({phase:'missing',service:name,tag})+'\\n');process.exit(127)}
   continue;
  }
  const image=JSON.parse(inspected.stdout)[0];
  if(!/^sha256:[a-f0-9]{64}$/i.test(image?.Id||'')||!Number.isFinite(Date.parse(image?.Created||'')))process.exit(127);
  fs.appendFileSync(observations,JSON.stringify({phase:'observed',service:name,tag,id:image.Id,created:image.Created,success:result.status===0})+'\\n');
 }
}
process.exit(result.status??1);
`;
  writeFileSync(shim, source, { mode: 0o700, flag: 'wx' });
  record.builder.shimDir = shimDir;
  record.builder.builtTagsFile = builtTagsFile;
  record.builder.overlayFile = overlayFile;
  const shimStat = lstatSync(shim);
  record.runState.shim = { dev: shimStat.dev, ino: shimStat.ino };
  if (record.file) writeAtomic(record.file, record);
  return shimDir;
}

/** Persist each selected wave's exact image witness, including partial failures. */
export function recordBuiltTags(record) {
  const file = record?.builder?.builtTagsFile;
  const rows = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const observed = rows.map((row) => JSON.parse(row));
  if (observed.some((row) => !record.plannedTags.includes(row.tag) ||
    row.tag !== record.project + '-' + row.service || !['planned', 'observed', 'missing'].includes(row.phase))) {
    throw new Error('Built image tag was not reserved before launch');
  }
  const potential = new Set(observed.filter((row) => row.phase === 'planned').map((row) => row.tag));
  const witnessed = new Map();
  for (const row of observed.filter((value) => value.phase === 'observed')) {
    if (!potential.has(row.tag) || !/^sha256:[a-f0-9]{64}$/i.test(row.id ?? '')
      || !Number.isFinite(Date.parse(row.created ?? ''))) throw new Error('Build wave image witness is invalid');
    const earlier = witnessed.get(row.tag);
    if (earlier && (earlier.id !== row.id || earlier.created !== row.created)) {
      throw new Error('Build wave image tag changed identity between observations');
    }
    witnessed.set(row.tag, row);
  }
  record.potentialBuiltTags = [...potential];
  record.observedImages = [...witnessed.values()];
  record.builtTags = record.observedImages.filter((image) => image.success).map((image) => image.tag);
  record.requiredBuiltTags = [...new Set([...record.builtTags,
    ...observed.filter((row) => row.phase === 'missing').map((row) => row.tag)])];
  if (record.file) writeAtomic(record.file, record);
  return record.builtTags;
}

export function verifyOwnedCache(record) {
  const saved = record.cache;
  if (!saved) return false;
  let current;
  try { current = lstatSync(saved.path); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== saved.dev || current.ino !== saved.ino
    || realpathSync(saved.path) !== saved.path
    || !saved.path.endsWith(path.join('run-state', record.token, 'turbo-cache'))) {
    throw new Error('Owned local cache root changed identity or became a symlink');
  }
  return true;
}

export function removeOwnedCache(record) {
  if (!record.cache) return;
  if (!verifyOwnedCache(record)) { record.cache = null; return; }
  const saved = record.cache;
  rmSync(saved.path, { recursive: true });
  record.cache = null;
}

export function verifyOwnedRunState(record) {
  const saved = record.runState;
  let current;
  try { current = lstatSync(saved.path); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== saved.dev || current.ino !== saved.ino
    || realpathSync(saved.path) !== saved.path || !saved.path.endsWith(path.join('run-state', record.token))) {
    throw new Error('Run-owned builder state root changed identity');
  }
  if (saved.shim) {
    let shim;
    try { shim = lstatSync(path.join(saved.path, 'bin', 'docker')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (shim && (!shim.isFile() || shim.isSymbolicLink() || shim.dev !== saved.shim.dev || shim.ino !== saved.shim.ino)) {
      throw new Error('Run-owned Docker shim changed identity');
    }
  }
  return true;
}

export function removeOwnedRunState(record) {
  if (!record.runState) return;
  if (!verifyOwnedRunState(record)) { record.runState = null; return; }
  const root = record.runState.path;
  const allowed = new Set(['buildkitd.toml', 'bin', 'built-tags.jsonl', 'owned-images.json']);
  if (readdirSync(root).some((name) => !allowed.has(name))) throw new Error('Run-owned state contains unknown files');
  if (existsSync(path.join(root, 'bin'))) {
    if (readdirSync(path.join(root, 'bin')).some((name) => name !== 'docker')) throw new Error('Run-owned shim directory contains unknown files');
    rmSync(path.join(root, 'bin', 'docker'), { force: true });
    rmdirSync(path.join(root, 'bin'));
  }
  rmSync(path.join(root, 'buildkitd.toml'), { force: true });
  rmSync(path.join(root, 'built-tags.jsonl'), { force: true });
  rmSync(path.join(root, 'owned-images.json'), { force: true });
  rmdirSync(root);
  record.runState = null;
}

export function removeRunOwnedBuilder(record, run) {
  if (!record.builder) return;
  const parts = verifiedBuilder(record, run);
  if (parts) {
    dockerResult(['buildx', 'rm', record.builder.name], run);
    if (verifiedBuilder(record, run)) throw new Error('Owned builder remains after removal');
  }
  record.builder = null;
}
