import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { syncFixture } from "./main-sync-test-fixtures.js";
import { stringify } from "yaml";

// Producer text is fixture data for hashing, never a local executable harness.
const REVIEWED_ELECTRON_RUN = [
  "set -o pipefail", "status=0", "dbus-run-session -- bash -c '",
  '  echo -n "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1',
  '  xvfb-run -a --server-args="-screen 0 1920x1080x24" pnpm test:e2e',
  "' || status=$?",
  "# Both guards are raised EXPLICITLY rather than leaning on the runner's",
  "# default `bash -e`: an implicit abort is the same kind of unstated",
  "# assumption that lost the exit code in the first place, and it is not",
  "# in force when this script is executed by its guard test.",
  "assert_status=0", "node scripts/assert-e2e-results.mjs || assert_status=$?",
  'if [ "$assert_status" = "78" ]; then',
  "  # ISS-5804. Green, with a tolerated worker teardown error \u2014 the one",
  "  # case where Playwright's exit 1 does not describe the suite.",
  '  if [ "$status" = "1" ]; then', "    status=0", "  fi",
  'elif [ "$assert_status" != "0" ]; then', "  status=1", "fi", 'exit "$status"', "",
].join("\n");

export function producerContents(run = REVIEWED_ELECTRON_RUN) {
  const definition = { jobs: { "desktop-e2e": { steps: [
    { name: "Checkout repository", uses: "actions/checkout@v7" },
    { id: "target-ref", run: 'echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"' },
    { name: "Run Electron e2e", run, env: { DD_GIT_COMMIT_SHA: "${{ steps.target-ref.outputs.sha }}" } },
  ] } } };
  return { encoding: "base64", content: Buffer.from(stringify(definition)).toString("base64") };
}

/** Synthetic GitHub responses preserve the observed main-definition versus tested-checkout distinction. */
export function installCiFixture(value: ReturnType<typeof syncFixture>) {
  const checkoutSha = value.git(["rev-parse", "HEAD"]);
  const file = join(value.metadata, "ci-fixture.json");
  const step = (number: number, name: string, start: string, end: string) => ({ number, name,
    status: "completed", conclusion: "success", started_at: `2026-10-09T00:00:${start}Z`, completed_at: `2026-10-09T00:00:${end}Z` });
  const fixture = { workflow: { id: 261474550, path: ".github/workflows/e2e-test.yml" },
    run: { id: 37896583565, event: "workflow_dispatch", status: "completed", conclusion: "success",
      head_branch: "main", head_sha: "a".repeat(40), path: ".github/workflows/e2e-test.yml", workflow_id: 261474550,
      run_attempt: 1, repository: { full_name: "closedloop-ai/symphony-alpha" }, head_repository: { full_name: "closedloop-ai/symphony-alpha" } },
    jobs: { total_count: 1, jobs: [{ id: 113709299734, run_id: 37896583565, run_attempt: 1,
      name: "desktop-e2e", status: "completed", conclusion: "success", steps: [
        step(2, "Checkout repository", "00", "01"), step(4, "Resolve target ref", "01", "02"), step(20, "Run Electron e2e", "10", "30"),
      ] }] },
    contents: producerContents(),
    log: [`2026-10-09T00:00:00.2500000Z [command]/usr/bin/git log -1 --format=%H`,
      `2026-10-09T00:00:00.2600000Z ${checkoutSha}`,
      "2026-10-09T00:00:10.0100000Z ##[group]Run set -o pipefail",
      `2026-10-09T00:00:10.0200000Z   DD_GIT_COMMIT_SHA: ${checkoutSha}`,
      "2026-10-09T00:00:10.0210000Z   DESKTOP_E2E_SMOKE_TAG: ",
      "2026-10-09T00:00:10.0220000Z   DESKTOP_E2E_CHANGED_SPECS: ",
      "2026-10-09T00:00:10.0300000Z ##[endgroup]",
      "2026-10-09T00:00:11.0000000Z Running 280 tests using 2 workers"].join("\n"), mutateSourceOnLog: false };
  const save = () => writeFileSync(file, JSON.stringify(fixture));
  save();
  writeFileSync(join(value.bin, "gh"), String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(), '.git', 'ci-reads.jsonl'), JSON.stringify(args) + '\n');
if (args[0] !== 'api') process.exit(2);
const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.git', 'ci-fixture.json'), 'utf8'));
const target = args[1]; let response;
if (target.endsWith('/actions/workflows/e2e-test.yml')) response = data.workflow;
else if (target.endsWith('/actions/runs/37896583565')) response = data.run;
else if (target.includes('/contents/')) response = data.contents;
else if (target.endsWith('/attempts/1/jobs?per_page=100')) response = data.jobs;
else if (target.endsWith('/actions/jobs/113709299734/logs')) {
  if (data.mutateSourceOnLog) fs.writeFileSync(path.join(process.cwd(), 'apps/app/probe.ts'), 'changed during CI read');
  process.stdout.write(data.log); process.exit(0);
} else process.exit(3);
process.stdout.write(JSON.stringify(response));
`, { mode: 0o700 });
  return { fixture, save, reads: () => readFileSync(join(value.metadata, "ci-reads.jsonl"), "utf8") };
}
