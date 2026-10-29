import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchBenchmarkGateInput } from "./github-pr-gate.ts";
import { validateBenchmarkDisclosure } from "./pr-body-gate.ts";

/** Read live GitHub state and run the model-free disclosure gate. */
export async function main(args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.length !== 1) throw new Error("usage: pr-body-gate-cli.ts <pull-request-number>");
  const number = Number(args[0]);
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const token = environment.GITHUB_TOKEN ?? "";
  const input = await fetchBenchmarkGateInput(repository, number, token);
  const result = validateBenchmarkDisclosure(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "fail") process.stderr.write(`::error title=Vibe benchmark disclosure::${result.message}\n`);
  return result.status === "pass" ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (status) => { process.exitCode = status; },
    (error) => { process.stderr.write(`::error title=Vibe benchmark gate failed::${String(error)}\n`); process.exitCode = 1; },
  );
}
