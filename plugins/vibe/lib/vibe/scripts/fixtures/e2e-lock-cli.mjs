// Existing CLI scenarios use independent namespaces and can never reserve an operator's actual slot.
import { e2eLockCli } from '../e2e-lock.mjs';
const args = process.argv.slice(2);
const at = args.indexOf('--lock-dir');
if (at < 0) throw new Error('E2E fixture requires its private lock directory');
const slot = args[at+1] + '.machine-slot';
if (args[0] === 'run' && !args.includes('--ticket')) args.splice(1,0,'--ticket','QA-42');
await e2eLockCli(args, slot);
