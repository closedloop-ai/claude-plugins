import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupDir, dockerResult, dockerRun, regularJson, writeAtomic } from './owned-state.mjs';

const BUILDER_NAME = 'vibe-build';
const BUILDER_VERSION = 1;
export const BUILDER_CACHE_CAP = '28GB';

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
  if ((kind === 'container' && (!/^[a-f0-9]{64}$/i.test(id ?? '') || value?.Name !== '/' + name))
    || kind === 'volume' && id !== name
    || !Number.isFinite(Date.parse(created ?? ''))) throw new Error('Builder part has no exact identity witness');
  return { name, id, created };
}

export function verifiedBuilder(record, run) {
  const builder = record.builder;
  if (!builder?.shared || builder.name !== BUILDER_NAME || !builder.recordFile) {
    throw new Error('Builder has no persistent vibe ownership record');
  }
  const saved = regularJson(builder.recordFile);
  if (saved.version !== BUILDER_VERSION || saved.kind !== 'vibe-builder' || saved.state !== 'ready'
    || saved.name !== BUILDER_NAME || saved.containerName !== builder.containerName || saved.volumeName !== builder.volumeName
    || JSON.stringify(saved.container) !== JSON.stringify(builder.container)
    || JSON.stringify(saved.volume) !== JSON.stringify(builder.volume)) throw new Error('Persistent builder ownership record changed');
  const container = inspectBuilderPart('container', builder.containerName, run);
  const volume = inspectBuilderPart('volume', builder.volumeName, run);
  if (!container || !volume || builder.container.id !== container.id || builder.container.created !== container.created
    || builder.volume.id !== volume.id || builder.volume.created !== volume.created) throw new Error('Builder identity witness changed');
  return { container, volume };
}

/** Reuse one persistently recorded vibe builder without selecting Docker's global builder. */
export function prepareRunOwnedBuild(record, { run = dockerRun, home, buildIntent = true } = {}) {
  if (!buildIntent || record?.kind !== 'e2e' || !record.absentAtReservation
    || record.project !== 'vibe-e2e-' + record.token || !/^[a-f0-9]{32}$/i.test(record.token ?? '')
    || record.state !== 'reserved' || record.builder) throw new Error('Generated E2E build intent and an unused reservation are required');
  const version = dockerResult(['buildx', 'version'], run);
  const match = /v(\d+)\.(\d+)(?:\.|\b)/.exec(version);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 14) throw new Error('Buildx 0.14 or newer is required for default-load');
  if (!dockerResult(['compose', 'build', '--help'], run).includes('--builder')) throw new Error('Compose selected-builder support is required');
  const name = BUILDER_NAME;
  const containerName = 'buildx_buildkit_' + name + '0';
  const volumeName = containerName + '_state';
  const stateRoot = home ? cleanupDir(home) : path.dirname(record.file);
  const builderFile = path.join(stateRoot, 'vibe-builder.json');
  let owned;
  try { owned = regularJson(builderFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!owned) {
    if (inspectBuilderPart('container', containerName, run) || inspectBuilderPart('volume', volumeName, run)) {
      throw new Error('Persistent builder exists without a vibe ownership record');
    }
    owned = { version: BUILDER_VERSION, kind: 'vibe-builder', state: 'creating', name, containerName, volumeName,
      absentAtReservation: true, createdAt: new Date().toISOString() };
    writeAtomic(builderFile, owned);
    const created = dockerResult(['buildx', 'create', '--driver', 'docker-container', '--driver-opt',
      'default-load=true', '--name', name, '--bootstrap'], run);
    if (created !== name) throw new Error('Buildx returned a different builder name');
    const container = inspectBuilderPart('container', containerName, run);
    const volume = inspectBuilderPart('volume', volumeName, run);
    if (!container || !volume || Date.parse(container.created) + 1_000 < Date.parse(owned.createdAt)
      || Date.parse(volume.created) + 1_000 < Date.parse(owned.createdAt)) throw new Error('Builder did not create exact post-reservation state');
    owned = { ...owned, state: 'ready', container, volume };
    writeAtomic(builderFile, owned);
  } else {
    if (owned.version !== BUILDER_VERSION || owned.kind !== 'vibe-builder' || owned.name !== name
      || owned.containerName !== containerName || owned.volumeName !== volumeName || owned.absentAtReservation !== true) {
      throw new Error('Persistent builder ownership record is unsupported');
    }
    if (owned.state === 'creating') {
      let container = inspectBuilderPart('container', containerName, run);
      let volume = inspectBuilderPart('volume', volumeName, run);
      if (!container && !volume) {
        owned.createdAt = new Date().toISOString();
        writeAtomic(builderFile, owned);
        const created = dockerResult(['buildx', 'create', '--driver', 'docker-container', '--driver-opt',
          'default-load=true', '--name', name, '--bootstrap'], run);
        if (created !== name) throw new Error('Buildx returned a different builder name');
        container = inspectBuilderPart('container', containerName, run);
        volume = inspectBuilderPart('volume', volumeName, run);
      }
      if (!container || !volume || Date.parse(container.created) + 1_000 < Date.parse(owned.createdAt)
        || Date.parse(volume.created) + 1_000 < Date.parse(owned.createdAt)) throw new Error('Incomplete persistent builder creation is not owned');
      owned = { ...owned, state: 'ready', container, volume };
      writeAtomic(builderFile, owned);
    }
    if (owned.state === 'ready') {
      let container = inspectBuilderPart('container', containerName, run);
      let volume = inspectBuilderPart('volume', volumeName, run);
      if (!container && !volume) {
        owned = { ...owned, state: 'creating', createdAt: new Date().toISOString(), container: undefined, volume: undefined };
        writeAtomic(builderFile, owned);
        const created = dockerResult(['buildx', 'create', '--driver', 'docker-container', '--driver-opt',
          'default-load=true', '--name', name, '--bootstrap'], run);
        if (created !== name) throw new Error('Buildx returned a different builder name');
        container = inspectBuilderPart('container', containerName, run);
        volume = inspectBuilderPart('volume', volumeName, run);
        if (!container || !volume || Date.parse(container.created) + 1_000 < Date.parse(owned.createdAt)
          || Date.parse(volume.created) + 1_000 < Date.parse(owned.createdAt)) throw new Error('Recreated builder lacks exact post-reservation state');
        owned = { ...owned, state: 'ready', container, volume };
        writeAtomic(builderFile, owned);
      } else if (!container || !volume || container.id !== owned.container?.id || container.created !== owned.container?.created
        || volume.id !== owned.volume?.id || volume.created !== owned.volume?.created) {
        throw new Error('Persistent builder identity witness changed');
      }
    }
    if (owned.state !== 'ready') throw new Error('Persistent builder is not ready');
  }
  const root = path.join(stateRoot, 'run-state', record.token);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  record.runState = { path: root, dev: rootStat.dev, ino: rootStat.ino };
  record.builder = { shared: true, recordFile: builderFile, name, containerName, volumeName,
    container: owned.container, volume: owned.volume };
  record.requiredBuiltTags ??= [];
  if (record.file) writeAtomic(record.file, record);
  verifiedBuilder(record, run);
  return { builder: record.builder };
}

/** Select only the recorded vibe builder and the current run's Docker shim. */
export function ownedBuildEnvironment(record, env = process.env) {
  if (!record?.builder?.container || !record?.runState?.path) throw new Error('Owned build environment needs exact builder and run-state witnesses');
  return { ...env, BUILDX_BUILDER: record.builder.name,
    ...(record.builder.shimDir ? { PATH: record.builder.shimDir + path.delimiter + (env.PATH ?? '') } : {}) };
}

/** A child-only Docker adapter pins every Compose build wave with --builder. */
export function installOwnedBuildShim(record, dockerBinary) {
  if (!record?.builder?.container || !path.isAbsolute(dockerBinary)) throw new Error('Build shim needs an exact builder and Docker executable');
  const shimDir = path.join(record.runState.path, 'bin');
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
  const allowed = new Set(['bin', 'built-tags.jsonl', 'owned-images.json']);
  if (readdirSync(root).some((name) => !allowed.has(name))) throw new Error('Run-owned state contains unknown files');
  if (existsSync(path.join(root, 'bin'))) {
    if (readdirSync(path.join(root, 'bin')).some((name) => name !== 'docker')) throw new Error('Run-owned shim directory contains unknown files');
    rmSync(path.join(root, 'bin', 'docker'), { force: true });
    rmdirSync(path.join(root, 'bin'));
  }
  rmSync(path.join(root, 'built-tags.jsonl'), { force: true });
  rmSync(path.join(root, 'owned-images.json'), { force: true });
  rmdirSync(root);
  record.runState = null;
}

/** Prune only the exact persistent vibe builder to its fixed retained cache cap. */
export function pruneOwnedBuilder(record, run = dockerRun) {
  if (!record.builder) return;
  verifiedBuilder(record, run);
  dockerResult(['buildx', 'prune', '--builder', record.builder.name, '--force', '--keep-storage', BUILDER_CACHE_CAP], run);
}
