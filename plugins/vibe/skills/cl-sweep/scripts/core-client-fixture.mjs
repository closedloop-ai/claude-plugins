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
