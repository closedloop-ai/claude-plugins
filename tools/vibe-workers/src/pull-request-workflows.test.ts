import { describe, expect, it } from "vitest";
import { pathFilteredPullRequestWorkflows } from "./pull-request-workflows.js";

const PLAYS = "pnpm --filter storybook test:branches-plays";
const jobs = `jobs:\n  plays:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install --frozen-lockfile\n      - run: ${PLAYS}\n`;
const workflow = (on: string) => ({ path: ".github/workflows/w.yml", text: `name: W\non:${on}\n${jobs}` });

describe("pathFilteredPullRequestWorkflows", () => {
  // Every `on:` layout GitHub accepts, with the changed files and whether the workflow runs on them (ISS-14394, PR 10008).
  const layouts: [string, string, string[], boolean][] = [
    ["map form, paths, matched", "\n  pull_request:\n    paths:\n      - 'packages/app/shared/**'\n", ["packages/app/shared/list.tsx"], true],
    ["map form, paths, unmatched", "\n  pull_request:\n    paths:\n      - 'packages/app/shared/**'\n", ["apps/api/route.ts"], false],
    ["single string pattern", "\n  pull_request:\n    paths: 'apps/storybook/**'\n", ["apps/storybook/stories/a.tsx"], true],
    ["flow sequence of patterns", "\n  pull_request:\n    paths: ['a/**', 'b/**']\n", ["b/x.ts"], true],
    ["negation after a match excludes", "\n  pull_request:\n    paths:\n      - 'packages/**'\n      - '!packages/**/*.md'\n", ["packages/app/README.md"], false],
    ["re-inclusion after a negation", "\n  pull_request:\n    paths:\n      - 'packages/**'\n      - '!packages/app/**'\n      - 'packages/app/shared/**'\n", ["packages/app/shared/x.ts"], true],
    ["a lone negation includes nothing", "\n  pull_request:\n    paths:\n      - '!docs/**'\n", ["src/x.ts"], false],
    ["single star stops at a slash", "\n  pull_request:\n    paths:\n      - 'packages/*'\n", ["packages/app/x.ts"], false],
    ["dot files match", "\n  pull_request:\n    paths:\n      - '.github/**'\n", [".github/workflows/w.yml"], true],
    ["paths-ignore with a file outside it runs", "\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n", ["docs/a.md", "src/x.ts"], true],
    ["paths-ignore covering every file does not run", "\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n", ["docs/a.md"], false],
    ["pull_request_target is a pull request event", "\n  pull_request_target:\n    paths:\n      - 'src/**'\n", ["src/x.ts"], true],
    ["push only is not a pull request event", "\n  push:\n    paths:\n      - 'src/**'\n", ["src/x.ts"], false],
    ["unfiltered map entry is general CI", "\n  pull_request:\n    branches: [main]\n", ["src/x.ts"], false],
    ["bare map entry is general CI", "\n  pull_request:\n", ["src/x.ts"], false],
    ["string form is general CI", " pull_request", ["src/x.ts"], false],
    ["array form is general CI", " [push, pull_request]", ["src/x.ts"], false],
  ];
  it.each(layouts)("%s", (_name, on, changed, runs) => {
    const matched = pathFilteredPullRequestWorkflows([workflow(on)], changed);
    expect(matched.length).toBe(runs ? 1 : 0);
    if (runs) expect(matched[0]?.commands).toEqual(["pnpm install --frozen-lockfile", PLAYS]);
    if (runs) expect(matched[0]?.jobChecks).toEqual([{ job: "plays", command: "pnpm install --frozen-lockfile" }, { job: "plays", command: PLAYS }]);
  });

  it("names only the changed files the filter matched", () => {
    const [matched] = pathFilteredPullRequestWorkflows([workflow("\n  pull_request:\n    paths:\n      - 'packages/design-system/**'\n")],
      ["packages/design-system/button.tsx", "apps/api/route.ts"]);
    expect(matched?.matchedFiles).toEqual(["packages/design-system/button.tsx"]);
  });

  it("refuses a workflow it cannot read instead of skipping it", () => {
    expect(() => pathFilteredPullRequestWorkflows([{ path: ".github/workflows/bad.yml", text: "on: [\n" }], ["x"])).toThrow(/bad\.yml: not a readable workflow/);
  });

  it("lists every run step of every job, and a job with no run step as one entry with no command", () => {
    const text = `name: W\non:\n  pull_request:\n    paths: ['src/**']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm install\n      - run: pnpm build\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: set -e; pnpm prebuild\n      - run: node verify.ts\n  action:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: org/act@v1\n`;
    const [matched] = pathFilteredPullRequestWorkflows([{ path: ".github/workflows/w.yml", text }], ["src/a.ts"]);
    expect(matched?.jobChecks).toEqual([{ job: "build", command: "pnpm install" }, { job: "build", command: "pnpm build" },
      { job: "verify", command: "set -e; pnpm prebuild" }, { job: "verify", command: "node verify.ts" }, { job: "action", command: null }]);
  });

  const steps = (condition: string, jobCondition = "") => `name: W\non:\n  pull_request:\n    paths: ['src/**']\njobs:\n  test:\n${jobCondition}    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm build\n      - run: pnpm test\n${condition}`;
  const checks = (text: string) => pathFilteredPullRequestWorkflows([{ path: ".github/workflows/w.yml", text }], ["src/a.ts"])[0]?.jobChecks;
  // Every condition layout, and whether the step is certainly off on a passing pull request (symphony-alpha pr-test.yml,
  // e2e-test.yml, coverage-main.yml): only a certainly-off step leaves the list; anything else stays required.
  it.each([
    ["continue-on-error with if: always()", "        if: always()\n        continue-on-error: true\n", false],
    ["continue-on-error alone (a later step can read its outcome)", "        continue-on-error: true\n", false],
    ["if: failure()", "        if: failure()\n", true],
    ["if: ${{ cancelled() }}", "        if: ${{ cancelled() }}\n", true],
    ["if: false", "        if: false\n", true],
    ["gated to push", "        if: github.event_name == 'push'\n", true],
    ["gated off pull_request (true under pull_request_target)", "        if: github.event_name != \"pull_request\"\n", false],
    ["gated to push, double quotes", "        if: github.event_name == \"push\"\n", true],
    ["if: always() without continue-on-error", "        if: always()\n", false],
    ["if: ${{ !cancelled() }}", "        if: ${{ !cancelled() }}\n", false],
    ["if: success() || failure()", "        if: success() || failure()\n", false],
    ["gate OR'd with merge_group", "        if: github.event_name == 'pull_request' || github.event_name == 'merge_group'\n", false],
    ["gated to pull_request_target", "        if: github.event_name == 'pull_request_target'\n", false],
    ["gated to pull_request", "        if: github.event_name == 'pull_request'\n", false],
    ["if: success()", "        if: success()\n", false],
    ["if: true", "        if: true\n", false],
    ["continue-on-error as an expression", "        continue-on-error: ${{ matrix.experimental }}\n", false],
  ])("a final step with %s: certainly off is %s", (_name, condition, off) => {
    expect(checks(steps(condition as string))).toEqual(off ? [{ job: "test", command: "pnpm build" }]
      : [{ job: "test", command: "pnpm build" }, { job: "test", command: "pnpm test" }]);
  });

  it("adds one entry with no command for a job whose check may be an action, but not for checkout or tool setup", () => {
    const text = `name: W\non:\n  pull_request:\n    paths: ['src/**']\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - run: pnpm install\n      - uses: org/lint-action@v1\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: pnpm build\n`;
    expect(checks(text)).toEqual([{ job: "lint", command: "pnpm install" }, { job: "lint", command: null }, { job: "build", command: "pnpm build" }]);
  });

  // GitHub's glob rules differ from picomatch for `?`, `+` and `**` inside a segment; such a pattern is read so the
  // workflow runs (GitHub's filter cheat sheet rows, and their negated and ignored forms).
  it.each([
    ["'*.jsx?' with page.js", "\n  pull_request:\n    paths: ['*.jsx?']\n", ["page.js"]],
    ["'apps/**.ts' across a slash", "\n  pull_request:\n    paths: ['apps/**.ts']\n", ["apps/web/x.ts"]],
    ["'+' after a character", "\n  pull_request:\n    paths: ['src/a+.ts']\n", ["src/aaa.ts"]],
    ["a negated GitHub-only glob never negates", "\n  pull_request:\n    paths: ['src/**', '!src/a?.ts']\n", ["src/ab.ts"]],
    ["an ignored GitHub-only glob never ignores", "\n  pull_request:\n    paths-ignore: ['docs/a?.md']\n", ["docs/ab.md"]],
  ])("a filter GitHub reads differently still runs the workflow: %s", (_name, on, changed) => {
    expect(pathFilteredPullRequestWorkflows([workflow(on as string)], changed as string[])).toHaveLength(1);
  });

  it("names each step's working directory in its check, from the step, the job's defaults or the workflow's", () => {
    const text = `name: W\non:\n  pull_request:\n    paths: ['src/**']\ndefaults:\n  run:\n    working-directory: apps/web\njobs:\n  web:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n  desktop:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: apps/desktop\n    steps:\n      - run: pnpm test\n      - run: pnpm lint\n        working-directory: packages/app\n`;
    expect(checks(text)).toEqual([{ job: "web", command: "cd apps/web && pnpm test" }, { job: "desktop", command: "cd apps/desktop && pnpm test" },
      { job: "desktop", command: "cd packages/app && pnpm lint" }]);
  });

  it("keeps a continue-on-error check whose outcome a later step enforces (dagger-ci.yml)", () => {
    const text = `name: W\non:\n  pull_request:\n    paths: ['src/**']\njobs:\n  dagger:\n    runs-on: ubuntu-latest\n    steps:\n      - id: check\n        run: pnpm test\n        continue-on-error: true\n      - run: echo failed; exit 1\n        if: steps.check.outcome != 'success'\n`;
    expect(checks(text)).toEqual([{ job: "dagger", command: "pnpm test" }, { job: "dagger", command: "echo failed; exit 1" }]);
  });

  it("lists a reusable-workflow job, which has no steps, as one entry with no command", () => {
    const text = `name: W\non:\n  pull_request:\n    paths: ['src/**']\njobs:\n  shared:\n    uses: ./.github/workflows/shared.yml\n`;
    expect(checks(text)).toEqual([{ job: "shared", command: null }]);
  });

  it("leaves out a job that is certainly off on a passing pull request, and keeps one whose condition may hold", () => {
    expect(checks(steps("", "    if: github.event_name == 'push'\n"))).toEqual([]);
    expect(checks(steps("", "    if: github.event_name == 'pull_request' || github.event_name == 'push'\n"))).toHaveLength(2);
  });
});
