// The host's shell queue grants admission with mkdir and prints the contents of owner on contention.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { readEvidence } from '../../handoff/scripts/handoff-evidence.mjs';

export const MACHINE_SLOT = '/tmp/cl-e2e.lock';

function recordText(slot, name) {
  return readEvidence(path.join(slot, name), undefined, 16 * 1024).text.trim();
}

/** The external wrapper's label is its only ticket input. Write the facts its own busy message displays. */
export function shellSlotOwner(label, project) {
  const ticket = /\b[A-Z][A-Z0-9]*-\d+\b/i.exec(label ?? '')?.[0]?.toUpperCase();
  if (!ticket || !project?.trim()) throw new Error('Machine E2E slot needs a ticket in its owner label and a compose project');
  return { owner: userInfo().username, label, ticket, composeProject: project };
}

/** Read both the structured holder and the shell's older free-form owner file. Unknown holders stay busy. */
export function machineSlotHolder(slot) {
  try {
    if (!lstatSync(slot).isDirectory()) return { label: 'unrecognized machine E2E slot' };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const text = recordText(slot, 'owner');
    let record;
    try { record = JSON.parse(text); } catch { /* An existing shell holder predates structured metadata. */ }
    if (record && ['owner', 'label', 'ticket', 'composeProject'].every(field => typeof record[field] === 'string' && record[field])) {
      return Object.fromEntries(['owner', 'label', 'ticket', 'composeProject'].map(field => [field, record[field]]));
    }
    const label = text.replace(/ since \d{2}:\d{2}$/, '');
    return { label: label || 'unidentified machine E2E holder' };
  } catch { return { label: 'machine E2E slot holder is initializing or unreadable' }; }
}

/** A machine lease is only reclaimed under its owning private Vibe lock. Shell leases never carry this marker. */
function ownLease(slot) {
  try {
    const directory = lstatSync(slot);
    if (!directory.isDirectory() || directory.uid !== process.getuid()) return null;
    const lease = JSON.parse(recordText(slot, 'vibe-lease.json'));
    return typeof lease.token === 'string' && /^[\da-f-]{36}$/i.test(lease.token) &&
      Number.isSafeInteger(lease.pid) && lease.pid > 1 ? lease : null;
  } catch { return null; }
}

/** Release only a Vibe token from this private lock namespace; unexpected entries remain untouched. */
export function releaseMachineSlot(slot, lockDir, token) {
  const lease = ownLease(slot);
  if (!lease || lease.token !== token || lease.lockDir !== lockDir) return;
  const names = readdirSync(slot);
  if (names.some(name => !['owner', 'vibe-lease.json'].includes(name))) return;
  // Never unlink a foreign pid, queue or directory tree.
  if (names.includes('owner')) unlinkSync(path.join(slot, 'owner'));
  unlinkSync(path.join(slot, 'vibe-lease.json'));
  rmdirSync(slot);
}

/** Hold the same mkdir used by the shell, retaining its lease while a recorded detached command is alive. */
export function claimMachineSlot(slot, lockDir, owner, alive) {
  const busy = () => machineSlotHolder(slot) ?? { label: 'machine E2E slot changed during admission' };
  function reserve() {
    try { mkdirSync(slot, { mode: 0o755 }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  if (!reserve()) {
    const lease = ownLease(slot);
    if (!lease || lease.lockDir !== lockDir || existsSync(path.join(slot, 'pid')) || alive(lease)) return busy();
    releaseMachineSlot(slot, lockDir, lease.token);
    if (!reserve()) return busy();
  }
  const acquired = lstatSync(slot);
  let recorded = false;
  try {
    // The old shell reaps a dead pid without checking child groups. Only the Vibe owner can recover this lease.
    writeFileSync(path.join(slot, 'vibe-lease.json'), JSON.stringify({ token: owner.token, pid: owner.pid, lockDir }), { flag: 'wx', mode: 0o600 });
    recorded = true;
    const metadata = { owner: owner.name, label: owner.label, ticket: owner.ticket, composeProject: owner.composeProject };
    writeFileSync(path.join(slot, 'owner'), JSON.stringify(metadata), { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (recorded) releaseMachineSlot(slot, lockDir, owner.token);
    else {
      // Another machine client may already own the name. Remove only our still-empty inode.
      const current = lstatSync(slot, { throwIfNoEntry: false });
      if (current?.dev === acquired.dev && current.ino === acquired.ino) {
        try { rmdirSync(slot); } catch (cleanup) {
          if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(cleanup.code)) throw cleanup;
        }
      }
    }
    throw error;
  }
  return null;
}
