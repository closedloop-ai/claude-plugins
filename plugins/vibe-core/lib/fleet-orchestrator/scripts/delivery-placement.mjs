import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultHome } from "./fleet-home.mjs";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { githubRepository } from "../../vibe/scripts/github-remote.mjs";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MARKER = /^\s*(?:[-*]\s+)?Delivery placement:\s*(.+?)\s*$/;
const HELP = "record one Delivery placement line naming an open unit, an open PR, or why the work is unrelated to the in-flight units";

/** GitHub identity of the target checkout, with no network access. */
export function deliveryRepository(cwd) {
  try {
    return githubRepository(execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch { return null; }
}

function openPullRequest(repository, number) {
  try {
    const state = execFileSync("gh", ["pr", "view", number, "--repo", repository, "--json", "state", "--jq", ".state"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return state === "OPEN" ? true : ["MERGED", "CLOSED"].includes(state) ? false : null;
  } catch { return null; }
}

/** Resolve this chat's own fleet board. Unknown or corrupt program state is not an empty board. */
function readDeliveryBoard(chat, env = process.env) {
  const home = defaultHome(env, chat);
  if (!existsSync(home)) return {};
  const { dir } = resolveWorkDir(home, { chat, env });
  const file = path.join(dir, "board.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function recordedPlacements(content) {
  const entries = [];
  let fence = null;
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (!fence) {
      const record = MARKER.exec(line)?.[1];
      if (record) entries.push(record);
    }
  }
  return entries;
}

/** The single creation boundary for tracker issues and new PRs in a delivery session. */
export function deliveryPlacementProblem({ content, repository, operation, board,
  chat, env = process.env, isOpenPullRequest = openPullRequest }) {
  const placements = recordedPlacements(content);
  if (placements.length !== 1) return HELP;
  if (!REPO.test(repository ?? "")) return "delivery placement needs the target GitHub repository";
  try { board ??= readDeliveryBoard(chat, env); }
  catch { return "the current fleet board could not be read; verify delivery placement against the bound program"; }

  const repo = repository.toLowerCase();
  const units = Object.entries(board.units ?? {}).filter(([, unit]) => {
    const owner = unit.repo ?? board.writers?.[unit.writer]?.repo;
    return !unit.closed && (!owner || owner.toLowerCase() === repo);
  });
  const [line] = placements;
  const unitName = /^unit\s+([\w.-]+)$/i.exec(line)?.[1];
  if (unitName) {
    const unit = units.find(([name]) => name === unitName)?.[1];
    if (!unit) return `unit ${unitName} is not open for ${repository}`;
    const existing = String(board.writers?.[unit.writer]?.pr ?? "").replace(/^#/, "");
    if (operation === "pull-request" && /^\d+$/.test(existing)) {
      const open = isOpenPullRequest(repository, existing);
      if (open !== false) return open === true
        ? `open PR #${existing} already delivers unit ${unitName}; add the work to that pull request`
        : `the recorded PR #${existing} for unit ${unitName} could not be verified; check it before opening another`;
    }
    return null;
  }
  const number = /^open PR #(\d+)$/i.exec(line)?.[1];
  if (number) {
    if (!isOpenPullRequest(repository, number)) return `PR #${number} could not be verified open for ${repository}`;
    return operation === "pull-request" ? `open PR #${number} already takes this work; add it there` : null;
  }
  const reason = /^unrelated:\s*(\S.*)$/i.exec(line)?.[1];
  if (!reason || /^none\.?$/i.test(reason)) return HELP;
  const named = new Set(reason.match(/[A-Za-z0-9_.-]+/g) ?? []);
  const omitted = units.map(([name]) => name).filter((name) => !named.has(name) && !named.has(`${name}.`));
  return omitted.length ? `state why the work is unrelated to these in-flight units for ${repository}: ${omitted.join(", ")}` : null;
}
