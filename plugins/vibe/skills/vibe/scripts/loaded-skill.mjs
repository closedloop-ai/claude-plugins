import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const ACTOR = /^[A-Za-z0-9_.:/-]{1,256}$/;
const DEFINITION = Object.freeze({ vibe: "skills/vibe/SKILL.md", "fleet-orchestrator": "skills/fleet-orchestrator/SKILL.md" });

function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

/** Machine-derived identity of the exact skill definition loaded for one actor. */
export function loadedSkillEvidence(actorId, runtime, pluginRoot, skill) {
  if (!ACTOR.test(actorId ?? "") || !["claude", "codex"].includes(runtime) || !DEFINITION[skill]) throw new Error("invalid loaded-skill actor, runtime or skill");
  const root = realpathSync(pluginRoot);
  const definition = realpathSync(path.join(root, DEFINITION[skill]));
  if (!definition.startsWith(`${root}${path.sep}`)) throw new Error("skill definition escapes its plugin root");
  const version = json(path.join(root, ".codex-plugin", "plugin.json")).version;
  return { actorId, runtime, skill, version, pluginRoot: root, definition: DEFINITION[skill], definitionSha256: sha256(definition) };
}

/** Why actor evidence is not the current installed definition, or null. */
export function loadedSkillEvidenceProblem(evidence, { actorId, pluginRoot }) {
  if (!evidence || evidence.actorId !== actorId || !ACTOR.test(evidence.actorId ?? "")) return "target actor has no machine-observed loaded skill evidence";
  let current;
  try { current = loadedSkillEvidence(actorId, evidence.runtime, pluginRoot, evidence.skill); }
  catch { return "target actor loaded-skill evidence is malformed"; }
  for (const key of ["runtime", "skill", "version", "pluginRoot", "definition", "definitionSha256"]) {
    if (evidence[key] !== current[key]) return `target actor loaded ${evidence.version ?? "unknown"} from another skill definition; reload the current installed skill`;
  }
  return null;
}
