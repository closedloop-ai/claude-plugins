import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const ACTOR = /^[A-Za-z0-9_.:/-]{1,256}$/;
const DEFINITION = Object.freeze({ vibe: "skills/vibe/SKILL.md", "fleet-orchestrator": "skills/fleet-orchestrator/SKILL.md" });
/**
 * Where load evidence came from. `hook-observed`: a Skill or UserPromptSubmit hook saw this
 * actor start the skill. `installed-at-spawn`: the orchestrator recorded the installed
 * definition when it created a fresh thread, a proxy for what that thread will read, not an
 * observation of the read (PR #371 review).
 * `reload-acknowledged`: the recorded actor acknowledged each exact definition page on its
 * App Server turn; this is never mislabeled as a hook-observed load.
 */
export const LoadBasis = Object.freeze({ HookObserved: "hook-observed", InstalledAtSpawn: "installed-at-spawn", ReloadAcknowledged: "reload-acknowledged" });

/** A closed, versioned wire envelope: no fields or free text can smuggle work through reload admission. */
export const SKILL_RELOAD = 'VIBE_SKILL_RELOAD v1';
export function isSkillReload(text, page) {
  return page ? text === skillReloadPage(page) : text === SKILL_RELOAD || text === `${SKILL_RELOAD}\n`;
}

/** Canonical page envelope: all content comes from the bound installed definition, never caller prose. */
export function skillReloadPage({ threadId, nonce, definition, definitionSha256, start, end, total, content }) {
  return `${SKILL_RELOAD}\n${JSON.stringify({ kind: 'page', threadId, nonce, definition, definitionSha256, start, end, total, content,
    instruction: 'Read this installed skill page and its required references. Run no other work until all pages are acknowledged.',
    acknowledge: `VIBE_SKILL_RELOAD_ACK v1 ${nonce}` })}`;
}

/** Compare strict release versions; unknown values never establish an upgrade. */
export function compareSkillVersions(left, right) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/;
  const a = version.exec(left ?? ''); const b = version.exec(right ?? '');
  if (!a || !b) return null;
  for (let i = 1; i < 4; i += 1) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
  return 0;
}

/** Only an authentic-shaped older actor binding qualifies for in-place recovery, never a wrong actor. */
export function reloadableSkill(evidence, { actorId, pluginRoot }) {
  if (!evidence || evidence.actorId !== actorId || !/^[a-f0-9]{64}$/.test(evidence.definitionSha256 ?? '')) return false;
  try {
    const current = loadedSkillEvidence(actorId, evidence.runtime, pluginRoot, evidence.skill, evidence.basis);
    return evidence.definition === current.definition && compareSkillVersions(evidence.version, current.version) === -1;
  } catch { return false; }
}

function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

/** Identity of the exact installed skill definition one actor loaded, and how that load is known. */
export function loadedSkillEvidence(actorId, runtime, pluginRoot, skill, basis) {
  if (!ACTOR.test(actorId ?? "") || !["claude", "codex"].includes(runtime) || !DEFINITION[skill]) throw new Error("invalid loaded-skill actor, runtime or skill");
  if (!Object.values(LoadBasis).includes(basis)) throw new Error(`loaded-skill basis must be ${Object.values(LoadBasis).join(" or ")}`);
  const root = realpathSync(pluginRoot);
  const definition = realpathSync(path.join(root, DEFINITION[skill]));
  if (!definition.startsWith(`${root}${path.sep}`)) throw new Error("skill definition escapes its plugin root");
  const version = json(path.join(root, ".codex-plugin", "plugin.json")).version;
  return { actorId, runtime, skill, basis, version, pluginRoot: root, definition: DEFINITION[skill], definitionSha256: sha256(definition) };
}

/** Why actor evidence is not the current installed definition, or null. */
export function loadedSkillEvidenceProblem(evidence, { actorId, pluginRoot }) {
  if (!evidence || evidence.actorId !== actorId || !ACTOR.test(evidence.actorId ?? "")) return "target actor has no recorded loaded skill evidence";
  let current;
  try { current = loadedSkillEvidence(actorId, evidence.runtime, pluginRoot, evidence.skill, evidence.basis); }
  catch { return "target actor loaded-skill evidence is malformed"; }
  for (const key of ["runtime", "skill", "version", "pluginRoot", "definition", "definitionSha256"]) {
    if (evidence[key] !== current[key]) return `target actor loaded ${evidence.version ?? "unknown"} from another skill definition; reload the current installed skill`;
  }
  return null;
}

/**
 * Whether a startup or program record must carry load evidence: the check found an evidence
 * source for its conversation, or evidence was recorded. Codex hooks run only after the person
 * trusts them, so without either the gate is not enforced.
 */
export function loadedSkillRequired(record) {
  return record?.loadedSkillRequired === true || typeof record?.loadedSkill?.actorId === "string";
}
