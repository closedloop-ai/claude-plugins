import { cloudRecipe } from "./cloud-validation-recipes.mjs";
const WEB_LIST = "e2e/run-containerized.sh -- --list";
const SPEC = /^test\/e2e\/[A-Za-z0-9/_.-]+\.spec\.[cm]?[jt]sx?$/;
const E2E_INTENT = /(?:\b(?:docker:ensure|e2e:containerized)\b|run-containerized\.sh|(?:^|\s|:)test:e2e\b|\bplaywright\s+test\b|(?:^|[\s"'])e2e\/|\/test\/e2e\/)/i;

const unavailable = (detail) => `{ printf '%s\\n' 'CLOUD_E2E_UNAVAILABLE: ${detail}' >&2; exit 78; }`;

/**
 * Resolve the repo-owned pnpm commands and capture their full output inside the cloud VM. A spec may name one
 * Playwright project the way the repository documents it (`-- --project=<name> <spec>`). The wrapper prints its log
 * and exit-file paths first and writes the exit code to that file, so a lane the Bash tool moves to the background
 * after 10 minutes can be polled to completion across calls.
 */
export const LANE_INDEX = "__VIBE_LANE_INDEX__";

export function pnpmContainerLane(command, readCommitted) {
  if (!/^pnpm (?:docker:ensure|e2e:containerized)(?:\s|$)/.test(command)) return null;
  const words = command.split(" ");
  const [, script, separator, ...rest] = words;
  const project = rest.length === 2 && /^--project=[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rest[0]) ? rest[0] : null;
  const argument = project ? rest[1] : rest[0];
  const singleSpec = /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.spec\.[cm]?[jt]sx?$/;
  const shaped = words.length === 2 || (script === "e2e:containerized" && separator === "--" &&
    ((rest.length === 1 && (argument === "--list" || singleSpec.test(argument))) || (project && singleSpec.test(argument))));
  if (!shaped) throw new Error("Cloud E2E lanes require the exact pnpm entry point and a documented container argument");
  try {
    const scripts = JSON.parse(readCommitted("package.json")).scripts;
    if (typeof scripts?.[script] !== "string" || !scripts[script].trim()) throw new Error("missing script");
    if (argument && argument !== "--list") readCommitted(argument.startsWith("e2e/") ? argument : "e2e/" + argument);
  } catch { throw new Error("CLOUD_E2E_UNAVAILABLE: required pnpm script or spec missing from the exact commit"); }
  // validationLanes replaces LANE_INDEX with the lane's final position. When the brief's private stream directory $d
  // exists, the wrapper writes its two summary lines into $d/<index>.stdout itself, so the machine record does not
  // depend on the agent redirecting a lane the Bash tool moved to the background; the exit-file pointer goes to stderr.
  return `(umask 077; ld=$(mktemp -d /tmp/vibe-lane.XXXXXXXX) || exit 1; out=; case "\${d:-}" in /tmp/vibe-lane-results-??????) [ -d "$d" ] && out="$d/${LANE_INDEX}.stdout";; esac; ` +
    `say() { if [ -n "$out" ]; then printf '%s\\n' "$1" >>"$out"; else printf '%s\\n' "$1"; fi; }; [ -z "$out" ] || : >"$out"; ` +
    `say "started log=$ld/output.log exit-file=$ld/exit"; [ -z "$out" ] || printf 'started exit-file=%s/exit summary=%s\\n' "$ld" "$out" >&2; ` +
    `rc=0; ${command} >"$ld/output.log" 2>&1 || rc=$?; printf '%s\\n' "$rc" >"$ld/exit"; say "exit=$rc log=$ld/output.log"; exit "$rc")`;
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
