// Every test result names the source it actually ran. A worker's container
// runs once tested an old commit for about an hour: a leftover modified file
// made each checkout in that worktree fail, the runs went on at the old head,
// and "23/23 passed" was reported for a pull request that was never tested.
// So a run starts only when the worktree's HEAD is the commit it means to
// test, and its result carries HEAD plus the uncommitted diff and tree hashes.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from "./session-record.mjs";

function matchedHead(worktree, intended) {
  if (!/^[0-9a-f]{7,40}$/i.test(intended ?? "")) throw new Error("name the commit to test as a SHA (--head <sha>)");
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.startsWith(intended.toLowerCase())) {
    throw new Error(`HEAD-MISMATCH the worktree is at ${head.slice(0, 12)}, not ${intended}: check out the commit to test (a failed checkout leaves the old one)`);
  }
  return head;
}

/** Preserve the external clean-run contract: the named HEAD with no modified tracked file. */
export function testedHead(worktree, intended) {
  const head = matchedHead(worktree, intended);
  const dirty = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error(`DIRTY-WORKTREE modified tracked files would make the run test something other than ${head.slice(0, 12)}: ${dirty.split("\n").map(line => line.replace(/^\s*\S+\s+/, "")).join(", ")}`);
  }
  return head;
}

// Frame every field so file names, binary contents and symlink targets cannot collide.
function field(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(`${bytes.length}:`).update(bytes);
}

function hashFiles(root, files, includeDeleted = false) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.join(root, file);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (includeDeleted) { field(hash, file); field(hash, 'deleted'); }
      continue;
    }
    field(hash, file);
    field(hash, stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : String(stat.mode & 0o111));
    if (stat.isSymbolicLink()) field(hash, readlinkSync(absolute));
    else if (stat.isFile()) field(hash, readFileSync(absolute));
    else if (!stat.isDirectory()) throw new Error(`Unsupported source entry: ${file}`);
  }
  return hash.digest('hex');
}

/** Hash a copied payload, including relative paths, executable bits and symlink targets. */
export function treeIdentity(root) {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      files.push(file);
      if (entry.isDirectory()) visit(file);
    }
  };
  visit('');
  return { treeSha256: hashFiles(root, files) };
}

/** Identify current tracked and nonignored untracked inputs; staging alone does not alter identity. */
export function sourceIdentity(worktree, intended = git(worktree, ['rev-parse', 'HEAD'])) {
  worktree = git(worktree, ['rev-parse', '--show-toplevel']);
  const head = matchedHead(worktree, intended);
  const run = (args) => execFileSync('git', ['-C', worktree, ...args], { maxBuffer: 128 * 1024 * 1024 });
  const names = (args) => run(args).toString('utf8').split('\0').filter(Boolean);
  const untracked = names(['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...names(['ls-tree', '-r', '--name-only', '-z', 'HEAD']), ...names(['ls-files', '-z'])];
  const changed = names(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
  validateSourceEntries(worktree, [...files, ...untracked]);
  const diffSha256 = hashFiles(worktree, [...changed, ...untracked], true);
  const source = { head, diffSha256, treeSha256: hashFiles(worktree, [...files, ...untracked]) };
  if (git(worktree, ['rev-parse', 'HEAD']) !== head) throw new Error('HEAD-MOVED while fingerprinting source');
  return source;
}

/** Resolve a named HEAD and return its complete dirty-aware source identity. */
export function testedSource(worktree, intended) {
  return sourceIdentity(worktree, intended);
}

function validateSourceEntries(root, files) {
  const selected = new Set(files.map(file => file.replace(/\/$/, '')));
  for (const name of selected) {
    const file = path.join(root, name);
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory()) throw new Error(`SOURCE-DIRECTORY-UNSUPPORTED ${name}: nested repositories and submodules are not self-contained source evidence`);
    if (!stat.isSymbolicLink()) continue;
    let resolved;
    let missing = false;
    try { resolved = realpathSync(file); }
    catch {
      resolved = path.resolve(path.dirname(file), readlinkSync(file));
      if (lstatExists(resolved)) throw new Error(`SYMLINK target cannot be resolved inside selected source: ${name}`);
      missing = true;
    }
    if (!inside(root, resolved)) throw new Error(`SYMLINK outside selected source: ${name}`);
    if (missing) continue;
    const target = path.relative(root, resolved);
    if (!selected.has(target) && ![...selected].some(entry => entry.startsWith(`${target}${path.sep}`))) {
      throw new Error(`SYMLINK target is not selected source: ${name}`);
    }
  }
}

/** Compare both provenance and content, detecting edits even when HEAD stays unchanged. */
export function sameSource(before, after) {
  return before.head === after.head && before.diffSha256 === after.diffSha256 && before.treeSha256 === after.treeSha256;
}

/** Validate the complete evidence wire identity rather than accepting a bare commit or partial hash. */
export function validSourceIdentity(source) {
  return /^[a-f0-9]{40}$/.test(source?.head ?? '') && ['diffSha256', 'treeSha256'].every(key => /^[a-f0-9]{64}$/.test(source?.[key] ?? ''));
}

/** Capture before any input read, bind the accepted identity, and reject sync or async source movement. */
export function withStableSource(worktree, operation, { head } = {}) {
  const before = sourceIdentity(worktree, head);
  const accept = result => {
    const after = sourceIdentity(worktree);
    if (!sameSource(before, after)) throw new Error(`SOURCE-MOVED ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return { ...result, source: before };
  };
  const result = operation(before);
  return result && typeof result.then === 'function' ? result.then(accept) : accept(result);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Copy Git-selected inputs only; ignored files and escaping or unselected symlink targets never enter a payload. */
export function copySourceTree(source, destination) {
  const root = realpathSync(source);
  const target = path.resolve(destination);
  if (inside(root, target)) throw new Error('Snapshot output must be outside its selected source root');
  return withStableSource(root, () => {
    const repo = git(root, ['rev-parse', '--show-toplevel']);
    const selected = execFileSync('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', path.relative(repo, root) || '.'], { encoding: 'utf8' })
      .split('\0').filter(Boolean).map(file => path.relative(root, path.join(repo, file)));
    const allowed = new Set(selected);
    const entries = new Map();
    const collect = (relative, output, ancestors = new Set()) => {
      const file = path.join(root, relative);
      let resolved;
      try { resolved = realpathSync(file); }
      catch (error) {
        if (error.code === 'ENOENT' && !lstatExists(file)) return; // A tracked deletion is absent from this snapshot.
        throw error;
      }
      if (!inside(root, resolved)) throw new Error(`SYMLINK outside selected root: ${relative}`);
      const actual = path.relative(root, resolved);
      const stat = lstatSync(resolved);
      if (stat.isDirectory()) {
        if (ancestors.has(resolved)) throw new Error(`SYMLINK cycle: ${relative}`);
        const next = new Set([...ancestors, resolved]);
        for (const child of selected.filter(name => name.startsWith(actual ? `${actual}${path.sep}` : ''))) {
          collect(child, path.join(output, path.relative(actual, child)), next);
        }
      } else if (stat.isFile() && allowed.has(actual)) {
        entries.set(output, { resolved, mode: stat.mode });
      } else throw new Error(`SYMLINK target is ignored, unselected or unsupported: ${relative}`);
    };
    for (const file of selected) collect(file, file);
    mkdirSync(target, { recursive: true });
    if (readdirSync(target).length) throw new Error('Snapshot destination must be empty');
    for (const [file, entry] of entries) {
      const out = path.join(target, file);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(entry.resolved));
      chmodSync(out, entry.mode & 0o777);
    }
    return treeIdentity(target);
  });
}

function lstatExists(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Freeze both plugin payloads before an eval. The copied tree hashes, rather than live HEAD, identify its inputs. */
export function snapshotPlugins(plugins, output) {
  const root = path.resolve(plugins);
  const out = path.resolve(output);
  if (out === root || out.startsWith(`${root}${path.sep}`)) throw new Error('Snapshot output must be outside the source plugins directory');
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) throw new Error('Snapshot output must be empty to preserve evidence');
  const receipt = withStableSource(root, () => {
    const payloads = {};
    for (const name of ['vibe', 'closedloop-core']) {
      const target = path.join(out, 'plugins', name);
      copySourceTree(path.join(root, name), target);
      payloads[name] = treeIdentity(target);
    }
    return { payloads };
  });
  writeFileSync(path.join(out, 'snapshot.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [kind, root, output, ...args] = process.argv.slice(2);
  if (!root || !['tree', 'source', 'copy', 'snapshot', 'claude-eval'].includes(kind)) throw new Error('Usage: tested-head.mjs source|tree <directory> | copy <source> <empty destination> | snapshot|claude-eval <plugins directory> <empty output directory> [eval args]');
  if (kind === 'copy') {
    if (!output) throw new Error('An empty destination is required');
    process.stdout.write(`${JSON.stringify(copySourceTree(root, output))}\n`);
  } else
  if (kind === 'snapshot' || kind === 'claude-eval') {
    if (!output) throw new Error('An empty output directory is required');
    const receipt = snapshotPlugins(root, output);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (kind === 'claude-eval') {
      const evalArgs = args.includes('--output-dir') ? args : [...args, '--output-dir', path.resolve(output, 'results')];
      const run = spawnSync('claude', ['plugin', 'eval', '.', '--eval-dir', 'vibe/evals', ...evalArgs], { cwd: path.resolve(output, 'plugins'), stdio: 'inherit' });
      const unchanged = Object.entries(receipt.payloads).every(([name, saved]) => treeIdentity(path.resolve(output, 'plugins', name)).treeSha256 === saved.treeSha256);
      writeFileSync(path.resolve(output, 'result.json'), `${JSON.stringify({ ...receipt, unchanged, exitCode: run.status, error: run.error?.message }, null, 2)}\n`);
      if (!unchanged) process.stderr.write('SOURCE-MOVED eval snapshot changed during the run; results are invalid\n');
      process.exitCode = unchanged ? run.status ?? 1 : 1;
    }
  } else process.stdout.write(`${JSON.stringify(kind === 'tree' ? treeIdentity(root) : sourceIdentity(root))}\n`);
}
