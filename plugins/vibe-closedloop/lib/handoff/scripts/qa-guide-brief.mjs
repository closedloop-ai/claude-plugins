import { proseLines } from "../../../shared/markdown-lines.mjs";
import { execFileSync } from "node:child_process";
import { capturedJson } from "../../vibe/scripts/captured-json.mjs";
import { githubRepository } from "../../vibe/scripts/github-remote.mjs";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { numberedCriteriaIds, ticketCriteria } from "../../../skills/handoff/scripts/criteria-list.mjs";
import { agentFrontmatterName } from "../../vibe/scripts/agent-frontmatter.mjs";
import { readEvidence } from "./handoff-evidence.mjs";

const template = new URL("../../../skills/fleet-orchestrator/references/qa-guide-prompt.md", import.meta.url);
const guideName = "closedloop-core:guided-manual-qa";

function field(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error("QA guide needs " + name);
  return value.trim();
}

// Compare numeric tokens rather than substrings (5 must never match 25).
function numberTokens(line) {
  return [...line.matchAll(/[+−-]?(?:\d+(?:[.,]\d+)*|\.\d+)/g)];
}

/** Require the observation to identify a complete captured setting and all of its quantities. */
function capturedQuote(text, quote) {
  if (text.trimStart().startsWith("{") && text.includes(quote)) {
    try {
      const object = JSON.parse(text);
      const entries = Object.entries(JSON.parse("{" + quote + "}"));
      if (entries.length === 1) {
        const [key, value] = entries[0];
        if (Object.hasOwn(object, key) && typeof value !== "object" && object[key] === value) return true;
      }
    } catch { /* A UI observation can also contain braces. */ }
  }
  const fields = text.split(/(?:\r?\n|[;|]|[.!?](?:\s+|$))/u);
  return fields.some(field => {
    const value = field.trim().replace(/^current\s+/i, "");
    return value === quote.trim().replace(/^current\s+/i, "").replace(/[.!?]$/, "");
  });
}

function origin(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid running product URL");
  return parsed.origin;
}

function distinctInput(directory, file, brief) {
  const source = realpathSync(path.resolve(directory, file));
  if (!source.startsWith(directory + path.sep)) throw new Error("QA evidence must be in the brief directory");
  const left = statSync(brief), right = statSync(source);
  if (left.dev === right.dev && left.ino === right.ino) throw new Error("QA criteria and observations require a distinct document");
  return source;
}

/** Keep criterion and checkpoint references attached to their independent plan declarations. */
function productLines(plan, stack, spec, brief) {
  const directory = path.dirname(brief);
  const checkpoints = new Set([...plan.matchAll(/^#{1,6}\s+(Q\d+)\b/gm)].map(match => match[1]));
  const criteria = new Set();
  if (spec.criteriaSource) {
    const source = distinctInput(directory, spec.criteriaSource, brief);
    const document = readEvidence(source).text;
    const prose = [...proseLines(document)].map(([,line])=>line).join("\n");
    for (const id of numberedCriteriaIds(document)) criteria.add(id);
    for (const row of ticketCriteria(prose)) criteria.add(row.id);
    for (const match of prose.matchAll(/^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s+)?(AC-\d+)\s*[:–—]\s*\S/gm)) criteria.add(match[1]);
  }
  return (plan + "\n" + stack).split(/\r?\n/).map(line => {
    const claim = line.trim();
    const product = claim.replace(/\b(?:Q\d+|AC-\d+)\b/g, id => {
      if (!(id.startsWith("AC-") ? criteria : checkpoints).has(id)) throw new Error("Unverified QA criterion or checkpoint " + id);
      return "";
    });
    return { claim, product };
  });
}

/** Match the named product setting and unit, permitting the guide's ordinary imperative wording. */
function claimWords(text) {
  let fieldText = text.trim().replace(/[.!?]$/, "");
  if (fieldText.startsWith('"')) {
    try {
      const entries = Object.entries(JSON.parse("{" + fieldText + "}"));
      if (entries.length === 1 && typeof entries[0][1] === "number") fieldText = entries[0].join(" ");
    } catch { /* Non-JSON observations keep their unit punctuation. */ }
  }
  fieldText = fieldText.replace(/^(?:check|verify|confirm|expect)\s+(?:that\s+)?(?:the\s+)?/i, "")
    .replace(/\s+is\s+(?=[+−-]?(?:\d|\.\d))/i, " ");
  return fieldText.match(/[+−-]?(?:\d+(?:[.,]\d+)*|\.\d+)|[\p{L}\p{M}]+|[^\s\p{L}\p{M}\d]/gu) ?? [];
}

/** Verify each numbered brief line against the operator's captured running-product observation before dispatch. */
function verifyNumbers(lines, checks, productOrigin, brief) {
  for (const {claim: line, product} of lines) {
    const claimed = numberTokens(product).map(match => match[0]);
    if (!claimed.length) continue;
    const check = checks.find(candidate => candidate?.claim === line);
    try {
      if (!check) throw new Error("missing observation");
      const capture = distinctInput(path.dirname(brief), check.evidence, brief);
      const evidence = JSON.parse(readEvidence(capture).text);
      const quote = field(check.observation, "an observed product value");
      const label = claimWords(product);
      if (!label.length || claimWords(quote).join(" ") !== label.join(" ")) throw new Error("observed field or unit differs");
      if (origin(evidence.url) !== productOrigin || typeof evidence.text !== "string" || !capturedQuote(evidence.text, quote)
        || JSON.stringify(claimed) !== JSON.stringify(numberTokens(quote).map(match => match[0]))) throw new Error("observation differs");
    } catch (cause) { throw new Error("Unverified running product number in " + line, { cause }); }
  }
}

/** Read the PR from its repository and bind its identifiers separately from product observations. */
function livePull(worktree, pr) {
  const remote = execFileSync("git", ["-C", worktree, "remote", "get-url", "origin"], {encoding:"utf8"}).trim();
  if (githubRepository(remote)?.toLowerCase() !== pr.repository.toLowerCase()) throw new Error("QA guide PR belongs to another repository");
  return capturedJson(execFileSync("gh", ["pr", "view", String(pr.number), "--repo", pr.repository, "--json", "url,headRefOid"],
    {cwd:worktree, encoding:"utf8", timeout:15000}));
}

function verifiedPull(worktree, pr, resolvePull) {
  if (!pr || !/^[\w.-]+\/[\w.-]+$/.test(pr.repository) || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      !/^[a-f0-9]{40}$/i.test(pr.head)) throw new Error("QA guide needs a typed PR repository, number and full head");
  const live = resolvePull(worktree, pr);
  if (live?.url?.toLowerCase() !== `https://github.com/${pr.repository}/pull/${pr.number}`.toLowerCase() ||
      live.headRefOid !== pr.head) throw new Error("QA guide PR head or identity differs from the running source record");
  return `Pull request ${pr.repository}#${pr.number} at ${pr.head}`;
}

/** Read and verify the coordinator's private inputs before any managed thread receives them. */
export function prepareGuide(file, worktree, resolvePull = livePull) {
  const spec = JSON.parse(readEvidence(file).text);
  const plan = field(spec.plan, "the QA plan");
  const stack = field(spec.stackFacts, "stack facts");
  const productOrigin = origin(field(spec.productOrigin, "the running product origin"));
  verifyNumbers(productLines(plan, stack, spec, realpathSync(file)), spec.numberChecks ?? [], productOrigin, realpathSync(file));
  const control = realpathSync(path.resolve(worktree, field(spec.controlSkill, "the repository control skill")));
  if (!control.startsWith(worktree + path.sep) || path.basename(control) !== "SKILL.md") throw new Error("Choose the repository control SKILL.md inside this checkout");
  const definition = readEvidence(control);
  if (agentFrontmatterName(definition.text) !== "control") throw new Error("Choose the repository's declared control skill");
  return [readEvidence(fileURLToPath(template)).text, verifiedPull(worktree, spec.pullRequest, resolvePull), "QA plan\n" + plan, "Stack facts\n" + stack, "Running product\n" + productOrigin,
    "Repository control skill " + control + "\n" + definition.text].join("\n\n");
}

/** Load the exact enabled QA skill installed in the guide's worktree context. */
export async function loadGuideSkill(client, worktree) {
  const { enabledCoreSkillPath } = await import("../../../skills/cl-sweep/scripts/resolve-core-skill.mjs");
  const listed = await client.request("skills/list", { cwds: [worktree], forceReload: true });
  const skill = enabledCoreSkillPath({ data: listed.data?.filter(entry => entry.cwd === worktree) }, guideName);
  return "Follow " + guideName + " at " + skill + ". Resolve its references from there.\n" + readEvidence(skill).text;
}
