import { parseArgs } from "node:util";
import { acceptManagedReviewer, launchQaGuide, runManagedReviewer } from "../../../plugins/vibe/lib/handoff/scripts/codex-review-runtime.mjs";
import { isModelName } from "../../../plugins/vibe/skills/vibe/scripts/agent-models.mjs";
import { runFromCanonicalEntry } from "./cli.js";

const usage = [
  "codex-reviewer.mjs run --orch-dir DIR --helper NAME --worktree DIR --role ROLE --model MODEL --capabilities FILE --brief FILE [--agent-definition FILE (visual-qa-critic)]",
  "codex-reviewer.mjs accept --orch-dir DIR --helper NAME --report FILE",
  "codex-reviewer.mjs qa-guide --orch-dir DIR --helper NAME --worktree DIR --writer-thread ID --model MODEL --brief FILE",
  "Accept only after independently checking the final report.",
].join("\n");
const stringOption = { type: "string" } as const;

/** A named read-only reviewer is launched once; the coordinator accepts its exact report separately. */
export async function main(argv: string[]): Promise<number> {
  const [action, ...args] = argv;
  if (argv.length === 1 && ["help", "--help", "-h"].includes(action!)) { console.log(usage); return 0; }
  if (action !== "run" && action !== "accept" && action !== "qa-guide") throw new Error(usage);
  const keys = action === "accept" ? ["report"] : action === "qa-guide" ? ["worktree", "writer-thread", "model", "brief"] : ["worktree", "role", "model", "capabilities", "brief", "agent-definition"];
  const options: Record<string, typeof stringOption> = Object.fromEntries(["orch-dir", "helper", ...keys].map(key => [key, stringOption]));
  const { values } = parseArgs({ args, options });
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) throw new Error("Missing --" + key + "\n" + usage);
    return value;
  };
  const orchDir = required("orch-dir");
  const helper = required("helper");
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(helper)) throw new Error("Use a simple, unique reviewer helper name");
  if (action === "accept") {
    console.log(JSON.stringify(await acceptManagedReviewer({ orchDir, helper, report: required("report") })));
  } else {
    const model = required("model");
    if (!isModelName(model)) throw new Error("Invalid reviewer model");
    if (action === "qa-guide") {
      console.log(JSON.stringify(await launchQaGuide({ orchDir, helper, model, worktree: required("worktree"),
        writerThread: required("writer-thread"), brief: required("brief") })));
      return 0;
    }
    console.log(JSON.stringify(await runManagedReviewer({ orchDir, helper, model, worktree: required("worktree"),
      role: required("role"), capabilities: required("capabilities"), brief: required("brief"),
      ...(values["agent-definition"] ? { agentDefinition: values["agent-definition"] } : {}) })));
  }
  return 0;
}

runFromCanonicalEntry(import.meta.url, main);
