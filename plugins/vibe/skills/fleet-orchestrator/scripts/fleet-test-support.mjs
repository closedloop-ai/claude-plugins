import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Install a fake remote Codex CLI for fleet shell tests without using the developer's CLI. */
export function writeRemoteCodexStub(bin, pluginRoot) {
  const target = join(bin, 'codex');
  writeFileSync(target, `#!${process.execPath}\nconst root=process.env.FAKE_REMOTE_PLUGIN_ROOT||${JSON.stringify(pluginRoot)}; console.log(JSON.stringify({installed:[{name:"vibe",installed:true,enabled:true,source:{path:root}}]}));\n`);
  chmodSync(target, 0o755);
}
