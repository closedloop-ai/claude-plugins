import { cloudRecipe } from "./cloud-validation-recipes.mjs";
const WEB_LIST = "e2e/run-containerized.sh -- --list";
const SPEC = /^test\/e2e\/[A-Za-z0-9/_.-]+\.spec\.[cm]?[jt]sx?$/;
const E2E_INTENT = /(?:\b(?:docker:ensure|e2e:containerized)\b|run-containerized\.sh|(?:^|\s|:)test:e2e\b|\bplaywright\s+test\b|(?:^|[\s"'])e2e\/|\/test\/e2e\/)/i;

const unavailable = (detail) => `{ printf '%s\\n' 'CLOUD_E2E_UNAVAILABLE: ${detail}' >&2; exit 78; }`;

/** Resolve the repo-owned pnpm commands and capture their full output inside the cloud VM. */
export function pnpmContainerLane(command, readCommitted) {
  if (!/^pnpm (?:docker:ensure|e2e:containerized)(?:\s|$)/.test(command)) return null;
  const words = command.split(" ");
  const [, script, separator, argument] = words;
  const singleSpec = /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.spec\.[cm]?[jt]sx?$/;
  if (words.length !== 2 && !(script === "e2e:containerized" && words.length === 4 && separator === "--" &&
    (argument === "--list" || singleSpec.test(argument)))) throw new Error("Cloud E2E lanes require the exact pnpm entry point and a documented container argument");
  try {
    const scripts = JSON.parse(readCommitted("package.json")).scripts;
    if (typeof scripts?.[script] !== "string" || !scripts[script].trim()) throw new Error("missing script");
    if (argument && argument !== "--list") readCommitted(argument.startsWith("e2e/") ? argument : "e2e/" + argument);
  } catch { throw new Error("CLOUD_E2E_UNAVAILABLE: required pnpm script or spec missing from the exact commit"); }
  return `(umask 077; d=$(mktemp -d /tmp/vibe-lane.XXXXXXXX) || exit 1; rc=0; ${command} >"$d/output.log" 2>&1 || rc=$?; printf 'exit=%s log=%s/output.log\\n' "$rc" "$d"; exit "$rc")`;
}

/** Name an E2E attempt even when its argv is outside the approved direct-lane shapes. */
export function looksLikeCloudE2E(command) {
  return typeof command === "string" && E2E_INTENT.test(command);
}

/**
 * Verify a documented E2E lane against exact committed files. Its generated command
 * probes the current cloud VM before any runner starts and never opens a display.
 */
export function resolveCloudE2ELane(command, readCommitted) {
  const committed = (file) => {
    try { return readCommitted(file); }
    catch { throw new Error(`CLOUD_E2E_UNAVAILABLE: required committed file ${file} is missing from the exact checkout`); }
  };
  if (command === WEB_LIST) {
    committed("e2e/run-containerized.sh");
    return `(command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || ${unavailable("Docker daemon and Compose are required by the containerized Web E2E list command.")}; ${WEB_LIST})`;
  }
  const directory = cloudRecipe.desktopRoot;
  const prefix = `pnpm --dir ${directory} test:e2e `;
  if (!directory || typeof command !== "string" || !command.startsWith(prefix)) return null;
  const argument = command.slice(prefix.length);
  const spec = argument.startsWith(directory + "/") ? argument.slice(directory.length + 1) : argument;
  if (!SPEC.test(spec) || spec.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  committed(`${directory}/${spec}`);
  const workflow = committed(".github/workflows/desktop-e2e-validation.yml").toString("utf8");
  if (!workflow.includes('xvfb-run -a --server-args="-screen 0 1920x1080x24" pnpm test:e2e')) {
    throw new Error("CLOUD_E2E_UNAVAILABLE: the exact commit does not name the supported displayless Desktop workflow");
  }
  return `(test "$(uname -s)" = Linux && command -v Xvfb >/dev/null && command -v xvfb-run >/dev/null && command -v xauth >/dev/null || ${unavailable("Desktop E2E requires the repository-supported Linux Xvfb and xauth harness.")}; cd ${directory} && xvfb-run -a --server-args="-screen 0 1920x1080x24" pnpm test:e2e ${spec})`;
}
