import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fixture registry points to one named skill; consumers still use the public process API. */
export function fixtureSkillPath() {
  const root = execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  }).trim();
  return join(root, 'plugins', 'closedloop-core', 'skills', 'gh-monitor-pr', 'SKILL.md');
}

/** Add registry and skills/list responses to an existing fake Codex CLI. */
export function registryFixtureCode(skillPath = fixtureSkillPath()) {
  return `
if (process.argv[2] === 'plugin') {
  process.stdout.write(JSON.stringify({installed:[{pluginId:'closedloop-core@closedloop-ai',installed:true,enabled:true,source:{source:'github',repo:'fixture/core'}}]})+'\\n');
  process.exit(0);
}
if (process.argv[2] === 'app-server' && process.argv[3] === '--stdio') {
  let buffer='';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{buffer+=chunk;let boundary;while((boundary=buffer.indexOf('\\n'))>=0){
    const message=JSON.parse(buffer.slice(0,boundary));buffer=buffer.slice(boundary+1);
    if(message.id){const result=message.method==='skills/list'?{data:[{cwd:process.cwd(),skills:[{name:'closedloop-core:gh-monitor-pr',pluginId:'closedloop-core@closedloop-ai',enabled:true,path:${JSON.stringify(skillPath)}}]}]}:{};
      process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');}
  }});
  process.stdin.on('end',()=>process.exit(0));
} else {
`;
}

/** Install only a fake registry CLI for injected-client unit tests, restoring exact environment state. */
export function installRegistryFixture() {
  const path = mkdtempSync(join(tmpdir(), 'core-client-registry-'));
  const executable = join(path, 'codex');
  writeFileSync(executable, `#!/usr/bin/env node\n${registryFixtureCode()}process.exitCode=2;\n}\n`);
  chmodSync(executable, 0o700);
  const priorPath = process.env.PATH;
  const priorClaude = process.env.CLAUDECODE;
  process.env.PATH = `${path}:${priorPath || ''}`;
  Reflect.deleteProperty(process.env, 'CLAUDECODE');
  return () => {
    if (priorPath == null) Reflect.deleteProperty(process.env, 'PATH'); else process.env.PATH = priorPath;
    if (priorClaude == null) Reflect.deleteProperty(process.env, 'CLAUDECODE'); else process.env.CLAUDECODE = priorClaude;
    rmSync(path, { recursive: true, force: true });
  };
}

/**
 * Points this process, and the commands it starts, at a model overrides file that never exists, so no test result
 * depends on the models this machine's person chose (ISS-14109). Returns that path.
 */
export function withoutModelOverrides() {
  const file = join(mkdtempSync(join(tmpdir(), 'cl-sweep-models-')), 'none.json');
  process.env.VIBE_MODELS_FILE = file;
  return file;
}

/** The models a fake Codex lists by default: the policy's default and high-complexity models. */
export const LISTED_MODELS = Object.freeze(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-luna']);

/**
 * Source for a fake `codex app-server` on stdio that answers `initialize` and `model/list` with `models`, or fails
 * every `model/list` when `models` is null. A fake CLI script inlines it under its own `app-server` branch.
 */
export function catalogServerCode(models = LISTED_MODELS) {
  return `{
  const models = ${JSON.stringify(models)};
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id === undefined) continue;
      const reply = message.method === 'initialize' ? { result: {} }
        : message.method === 'model/list' && models ? { result: { data: models.map((model) => ({ id: model, model })), nextCursor: null } }
        : { error: { code: -32601, message: 'unsupported in fixture: ' + message.method } };
      process.stdout.write(JSON.stringify({ id: message.id, ...reply }) + '\\n');
    }
  });
}`;
}

/**
 * Puts a fake `codex` first on this process's PATH, inherited by the commands it starts, whose App Server lists
 * `models` (null: its model list cannot be read). The session scripts read the model list from the \`codex\` on PATH
 * unless --codex names another, so no test result depends on this machine's Codex. Returns the fake's path.
 */
export function withModelCatalog(models = LISTED_MODELS) {
  const directory = mkdtempSync(join(tmpdir(), 'cl-sweep-codex-catalog-'));
  const codex = join(directory, 'codex');
  writeFileSync(codex, `#!/usr/bin/env node
if (process.argv[2] === 'app-server' && process.argv.length === 3) ${catalogServerCode(models)}
else { process.stderr.write('fake codex: only app-server on stdio'); process.exitCode = 2; }
`);
  chmodSync(codex, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return codex;
}
