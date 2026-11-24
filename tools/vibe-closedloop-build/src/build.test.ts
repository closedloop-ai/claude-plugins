import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_DATA, BUILD_MARKER, buildClosedLoopVibe, type BuildPaths, builtText, DEFAULT_PATHS, isExcluded, REPO, sourceFiles } from "./build.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-closedloop-build-test-"));
  made.push(dir);
  return dir;
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const RECIPES_NOTE = "Recipe text applies where the repository opts in.";
const POINTER = "Read `{path}` at this step.";

/** A source plugin and a provider, both synthetic; `files` are the source plugin's, `blocks` the provider's reference files. */
function fixture(files: Record<string, string>, blocks: Record<string, string>, data: Record<string, unknown> = {}): BuildPaths {
  const root = temp();
  const source = join(root, "source");
  const provider = join(root, "provider");
  execFileSync("git", ["init", "-q", source]);
  write(join(source, ".claude-plugin/plugin.json"), JSON.stringify({ name: "vibe-generic", version: "2.0.0", description: "generic" }));
  for (const [name, text] of Object.entries(files)) write(join(source, name), text);
  write(join(provider, ".claude-plugin/plugin.json"), JSON.stringify({ name: "acme-provider", version: "1.0.0" }));
  write(join(provider, "provider.json"), JSON.stringify({ vibeProvider: 1, name: "acme-provider", skill: "acme", references: "refs",
    capabilities: { tickets: { needs: [] }, recipes: { needs: ["repo-file:.acme/recipes.json"] } } }));
  mkdirSync(join(provider, "refs"), { recursive: true });
  for (const [name, text] of Object.entries(blocks)) write(join(provider, "refs", name), text);
  write(join(provider, BUILD_DATA), JSON.stringify({ manifests: {}, descriptions: {}, cold: {}, coldPointer: POINTER,
    recipesNote: RECIPES_NOTE, place: {}, ...data }));
  return { source, provider, output: join(root, "out") };
}

const stub = (capability: string, id: string, file = "skill.md") => `> Provider \`${capability}\` (block \`${id}\` of \`${file}\`)`;
const block = (id: string, text: string) => `<!-- block: ${id} -->\n${text}\n<!-- end: ${id} -->\n`;
const generic = (id: string, text: string) => `<!-- generic: ${id} -->\n${text}\n<!-- end generic: ${id} -->\n`;

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(dir, path), `${(statSync(path).mode & 0o777).toString(8)} ${readFileSync(path).toString("base64")}`);
    }
  };
  walk(dir);
  return out;
}

describe("the files the build reads", () => {
  it("AC-018 refuses duplicate marketplace display names before replacing the output", () => {
    const codex = ".codex-plugin/plugin.json";
    const paths = fixture({ [codex]: JSON.stringify({ name: "vibe-generic", interface: { displayName: "Acme Vibe" } }) }, {},
      { manifests: { [codex]: { interface: { displayName: " acme vibe " } } } });
    const marker = join(paths.output, "existing.txt");
    write(marker, "prior generation\n");
    expect(() => buildClosedLoopVibe(paths)).toThrow(/same marketplace display name/);
    expect(readFileSync(marker, "utf8")).toBe("prior generation\n");
  });

  it("leaves out tests, evals, fixtures, caches and test support, and keeps runtime files that only look like tests", () => {
    const paths = fixture({
      "evals/case/prompt.md": "x", "evals/codex/model-policy.json": "{}", "tools/python/test_a.py": "x", "tools/python/skill_split.py": "x",
      "skills/a/scripts/run.test.mjs": "x", "skills/a/scripts/fixtures/f.json": "{}", "skills/a/scripts/__pycache__/m.pyc": "x",
      "skills/cl-work-report/scripts/test_render_report.py": "x", "skills/vibe/scripts/test-fixtures.mjs": "x",
      "skills/vibe/scripts/skill-split.mjs": "x", "skills/handoff/scripts/diff-rules-test-fixture.mjs": "x",
      "skills/handoff/scripts/frozen-render-test-fixture.mjs": "x", "skills/any/scripts/new-module-test-fixture.mjs": "x",
      "skills/codex-fleet-monitor/scripts/test-support.mjs": "x", "skills/fleet-orchestrator/scripts/fleet-test-support.mjs": "x",
      "skills/cl-sweep/scripts/core-client-fixture.mjs": "x", "skills/a/scripts/next-test-fixture.mjs": "x",
      "skills/a/scripts/run.mjs": "x", "skills/vibe/scripts/test-files.mjs": "x", "skills/handoff/scripts/targeted-tests-ruling.mjs": "x",
    }, {});
    expect(sourceFiles(paths.source)).toEqual([".claude-plugin/plugin.json", "evals/codex/model-policy.json", "skills/a/scripts/run.mjs",
      "skills/handoff/scripts/targeted-tests-ruling.mjs", "skills/vibe/scripts/test-files.mjs"]);
  });

  it("ships every runtime file of plugins/vibe and no test", () => {
    const files = sourceFiles(DEFAULT_PATHS.source);
    // The Codex model policy is runtime data (cl-sweep/scripts/model-policy.mjs reads it at load); no other eval file ships.
    expect(files.filter((file) => /\.test\.|(?:^|\/)test_[^/]*\.py$|^evals\/(?!codex\/model-policy\.json$)|^tools\/|\/fixtures\/|-test-fixture\.mjs$|(?:^|\/|-)test-support\.mjs$/.test(file))).toEqual([]);
    for (const runtime of ["skills/vibe/scripts/test-files.mjs", "skills/vibe/scripts/tested-head.mjs", "skills/handoff/scripts/test-integrity.mjs",
      "skills/vibe/scripts/dist/main-sync.mjs", "lib/vibe/scripts/provider.mjs", "hooks/hook-dispatch.mjs", "hooks/protected-write-guard.mjs", "shared/process-identity.mjs", "skills/cl-work-report/assets/mermaid-11.16.0.min.js", "evals/codex/model-policy.json"]) expect(files).toContain(runtime);
    expect(isExcluded("skills/vibe/scripts/test-fixtures.mjs")).toBe(true);
  });
});

describe("assembly", () => {
  it("moves a cold section, the text between its blocks included, to one file and leaves one pointer line", () => {
    const paths = fixture({
      "skills/vibe/SKILL.md": `# Skill\n\n## Deploy\n\n${generic("deploy", "Generic deploy step.")}${stub("recipes", "deploy")}\n`
        + `Shared line between the blocks.\n${generic("deploy-2", "Generic second step.")}${stub("recipes", "deploy-2")}\n\n## Next\n`,
    }, { "skill.md": `${block("deploy", "Acme deploy step.")}\n${block("deploy-2", "Acme second step.")}` },
    { cold: { "skill.md": [["deploy", "deploy-2"]] } });
    buildClosedLoopVibe(paths);
    const skill = readFileSync(join(paths.output, "skills/vibe/SKILL.md"), "utf8");
    expect(skill).toBe("# Skill\n\n## Deploy\n\nRead `references/closedloop-deploy.md` at this step.\n\n## Next\n");
    expect(readFileSync(join(paths.output, "skills/vibe/references/closedloop-deploy.md"), "utf8"))
      .toBe(`${RECIPES_NOTE}\n\nAcme deploy step.\nShared line between the blocks.\nAcme second step.\n`);
  });

  it("puts the recipes line only in files whose inline text holds a recipes-only block", () => {
    const paths = fixture({
      "agents/recipes.md": `---\nname: r\n---\n\nIntro.\n${stub("recipes", "r1")}\n`,
      "agents/tickets.md": `# Tickets\n\n${stub("tickets", "t1")}\n`,
      "agents/joined.md": `# Joined\n\n${stub("recipes+tickets", "j1")}\n`,
      "agents/cold.md": `# Cold\n\n${stub("recipes", "c1")}\n`,
      "agents/heading.md": `# Heading\n\nBody.\n${stub("recipes", "h1")}\n`,
    }, { "skill.md": ["r1", "t1", "j1", "c1", "h1"].map((id) => block(id, `Block ${id}.`)).join("\n") }, { cold: { "skill.md": [["c1"]] } });
    buildClosedLoopVibe(paths);
    const text = (name: string) => readFileSync(join(paths.output, name), "utf8");
    expect(text("agents/recipes.md")).toBe(`---\nname: r\n---\n\n${RECIPES_NOTE}\n\nIntro.\nBlock r1.\n`);
    expect(text("agents/heading.md")).toBe(`# Heading\n\n${RECIPES_NOTE}\n\nBody.\nBlock h1.\n`);
    expect(text("agents/tickets.md")).not.toContain(RECIPES_NOTE);
    expect(text("agents/joined.md")).not.toContain(RECIPES_NOTE);
    expect(text("agents/cold.md")).toBe("# Cold\n\nRead `closedloop-c1.md` at this step.\n");
    expect(text("agents/closedloop-c1.md")).toBe(`${RECIPES_NOTE}\n\nBlock c1.\n`);
  });

  it("rewrites provider names to paths from the file to where build.json places the reference, and refuses a name it does not place", () => {
    const blocks = { "skill.md": block("t1", "Read `provider:ticket-template.md` and [it](provider:sub/units.md)."),
      "ticket-template.md": "# Template\n", "sub/units.md": "# Units\n" };
    const place = { "ticket-template.md": "skills/vibe/references/ticket-template.md", "sub/units.md": "skills/fleet/references/units.md" };
    const paths = fixture({ "agents/a.md": `${stub("tickets", "t1")}\n`, "skills/x/references/b.md": `${stub("tickets", "t1")}\n` }, blocks, { place });
    buildClosedLoopVibe(paths);
    expect(readFileSync(join(paths.output, "agents/a.md"), "utf8"))
      .toBe("Read `../skills/vibe/references/ticket-template.md` and [it](../skills/fleet/references/units.md).\n");
    expect(readFileSync(join(paths.output, "skills/x/references/b.md"), "utf8"))
      .toBe("Read `../../vibe/references/ticket-template.md` and [it](../../fleet/references/units.md).\n");
    expect(readFileSync(join(paths.output, "skills/vibe/references/ticket-template.md"), "utf8")).toBe("# Template\n");
    const missing = fixture({ "agents/a.md": `${stub("tickets", "t1")}\n` }, { "skill.md": block("t1", "Read `provider:gone.md`.") },
      { place: { "gone.md": "skills/vibe/references/gone.md" } });
    expect(() => buildClosedLoopVibe(missing)).toThrow(/places gone\.md, which the provider does not have/);
    const unplaced = fixture({ "agents/a.md": `${stub("tickets", "t1")}\n` }, { "skill.md": block("t1", "Read `provider:skill.md`.") });
    expect(() => buildClosedLoopVibe(unplaced)).toThrow(/names provider:skill\.md, which build\.json does not place/);
  });

  it("places each whole reference file once, refuses one left unplaced, a placed block source and a place outside the plugin", () => {
    const blocks = { "skill.md": block("t1", "Text."), "ticket-template.md": "# Template\n" };
    expect(() => buildClosedLoopVibe(fixture({}, blocks))).toThrow(/ticket-template\.md is neither a block source nor placed/);
    expect(() => buildClosedLoopVibe(fixture({}, blocks, { place: { "ticket-template.md": "a.md", "skill.md": "b.md" } })))
      .toThrow(/places skill\.md, a block source/);
    for (const target of ["provider/references/ticket-template.md", "../ticket-template.md", "skills/../../x.md", "/abs.md"]) {
      expect(() => buildClosedLoopVibe(fixture({}, blocks, { place: { "ticket-template.md": target } })), target)
        .toThrow(/not a path in the plugin outside provider/);
    }
  });

  it("names skills and agents as vibe: whatever the source plugin calls itself", () => {
    const paths = fixture({ "skills/a/SKILL.md": "Run `/vibe-generic:vibe`, then `vibe-generic:handoff`; `my-vibe-generic:x` stays.\n" }, {});
    buildClosedLoopVibe(paths);
    expect(readFileSync(join(paths.output, "skills/a/SKILL.md"), "utf8")).toBe("Run `/vibe:vibe`, then `vibe:handoff`; `my-vibe-generic:x` stays.\n");
    expect(JSON.parse(readFileSync(join(paths.output, ".claude-plugin/plugin.json"), "utf8")).name).toBe("vibe");
  });

  it("names the generic plugin's own install id and cache folder as vibe's, and nothing that only resembles them", () => {
    const text = "Run `codex plugin add vibe-generic@closedloop-ai`, then `ls ~/.codex/plugins/cache/*/vibe-generic/*/skills`"
      + " or `cache/<marketplace>/vibe-generic/<version>/`; `my-vibe-generic@x`, `vibe-generic-x/`, `vibe-generic.md` and `/vibe-generic` stay.\n";
    const paths = fixture({ "skills/a/SKILL.md": text }, {});
    buildClosedLoopVibe(paths);
    expect(readFileSync(join(paths.output, "skills/a/SKILL.md"), "utf8")).toBe("Run `codex plugin add vibe@closedloop-ai`, then `ls ~/.codex/plugins/cache/*/vibe/*/skills`"
      + " or `cache/<marketplace>/vibe/<version>/`; `my-vibe-generic@x`, `vibe-generic-x/`, `vibe-generic.md` and `/vibe-generic` stay.\n");
  });

  it("keeps a replacement description inside its flow mapping", () => {
    const paths = fixture({ "agents/a.md": "---\n{name: sample, description: Old}\n---\nBody.\n" }, {},
      { descriptions: { "agents/a.md": "Build, then verify." } });
    buildClosedLoopVibe(paths);
    expect(readFileSync(join(paths.output, "agents/a.md"), "utf8")).toContain('{name: sample, description: "Build, then verify."}');
  });

  it("AC-082 replaces the YAML description scalar and preserves the rest of the skill", () => {
    const before = "\uFEFF---\r\n'description': 'old' # retained\r\nname: a\r\n---\r\ndescription: body\r\n";
    const paths = fixture({ "agents/a.md": before }, {}, { descriptions: { "agents/a.md": "value: with punctuation" } });
    buildClosedLoopVibe(paths);
    const built = readFileSync(join(paths.output, "agents/a.md"), "utf8");
    expect(built).toBe(before.replace("'old'", '"value: with punctuation"'));
  });

  it("writes the provider's manifest and frontmatter descriptions, its contract with the placement, and each placed file over the source's", () => {
    const paths = fixture({ "agents/a.md": "---\nname: a\ndescription: generic words\nmodel: x\n---\nBody.\n", "bin/run.sh": "#!/bin/sh\n",
      "skills/vibe/references/graph.md": "Generic graph text.\n" },
      { "ticket-template.md": "# Template\n", "graph.md": "# Acme graph\n", "skill.md": block("t1", "Text.") },
      { manifests: { ".claude-plugin/plugin.json": { description: "Acme vibe" } }, descriptions: { "agents/a.md": "Acme words" },
        place: { "ticket-template.md": "skills/vibe/references/ticket-template.md", "graph.md": "skills/vibe/references/graph.md" } });
    execFileSync("chmod", ["+x", join(paths.source, "bin/run.sh")]);
    buildClosedLoopVibe(paths);
    expect(JSON.parse(readFileSync(join(paths.output, ".claude-plugin/plugin.json"), "utf8")))
      .toEqual({ name: "vibe", version: "2.0.0", description: "Acme vibe" });
    expect(readFileSync(join(paths.output, "agents/a.md"), "utf8")).toBe("---\nname: a\ndescription: Acme words\nmodel: x\n---\nBody.\n");
    expect(statSync(join(paths.output, "bin/run.sh")).mode & 0o111).not.toBe(0);
    const contract = JSON.parse(readFileSync(join(paths.output, "provider/provider.json"), "utf8"));
    expect([contract.references, contract.placed]).toEqual(["..", { "ticket-template.md": "skills/vibe/references/ticket-template.md",
      "graph.md": "skills/vibe/references/graph.md" }]);
    expect(readFileSync(join(paths.output, "skills/vibe/references/ticket-template.md"), "utf8")).toBe("# Template\n");
    expect(readFileSync(join(paths.output, "skills/vibe/references/graph.md"), "utf8")).toBe("# Acme graph\n");
    expect(readdirSync(join(paths.output, "provider")), "no block file and no build data").toEqual(["provider.json"]);
  });
});

describe("the ClosedLoop vibe from this repository", () => {
  it("AC-018 exposes distinct marketplace names for the generic and provider variants", () => {
    const codex = ".codex-plugin/plugin.json";
    const generic = JSON.parse(readFileSync(join(DEFAULT_PATHS.source, codex), "utf8"));
    const built = JSON.parse(builtText(codex));
    expect(generic.interface.displayName).toBe("Vibe Generic");
    expect(generic.interface.shortDescription).toBe("Start a vibe session in any Git repository.");
    expect(built.interface.displayName).toBe("ClosedLoop Vibe");
  });

  const output = () => {
    const dir = join(temp(), "vibe");
    buildClosedLoopVibe({ ...DEFAULT_PATHS, output: dir });
    return dir;
  };

  it("is the same bytes and modes on every build", () => {
    expect(tree(output())).toEqual(tree(output()));
  });

  it("ISS-14162 writes a generated marker at its root naming the directory it was built from", () => {
    const dir = output();
    expect(readdirSync(dir)).toContain(BUILD_MARKER);
    expect(JSON.parse(readFileSync(join(dir, BUILD_MARKER), "utf8"))).toEqual({ builtFrom: "plugins/vibe" });
    expect(readFileSync(join(REPO, "plugins/vibe-closedloop", BUILD_MARKER), "utf8"), "the committed plugin carries the same marker")
      .toBe(readFileSync(join(dir, BUILD_MARKER), "utf8"));
  });

  it("holds no stub, no rule region, no provider name and no generic prefix (references.test.ts resolves every path)", () => {
    const dir = output();
    for (const [file] of tree(dir)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/^> Provider `/m);
      expect(text, file).not.toMatch(/provider-rule|^Lines (?:that start|of the form) `/m);
      expect(text, file).not.toMatch(/(?<![\w-])provider:[\w./-]+\.md/);
    }
    expect(readFileSync(join(dir, "skills/vibe/SKILL.md"), "utf8")).toContain("Read `references/closedloop-deploy.md`");
  });

  it("carries main's manifest and frontmatter descriptions", () => {
    const base = "8a858bb4a49f9eb1b1d6423e00c0bb75d77925e8";
    const show = (file: string) => execFileSync("git", ["-C", REPO, "show", `${base}:plugins/vibe/${file}`], { encoding: "utf8" });
    try { show(".claude-plugin/plugin.json"); } catch { return; } // A shallow clone has no base commit to compare with.
    const dir = output();
    for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
      const main = JSON.parse(show(manifest));
      const built = JSON.parse(readFileSync(join(dir, manifest), "utf8"));
      expect(built.description).toBe(main.description);
      expect(built.name).toBe("vibe");
      if (main.interface) {
        expect(built.keywords).toEqual(main.keywords);
        expect(built.interface.shortDescription).toBe(main.interface.shortDescription);
        expect(built.interface.longDescription).toBe(main.interface.longDescription);
      }
    }
    const description = (text: string) => /^---\n[\s\S]*?^description: (.*)$/m.exec(text)?.[1];
    // The one deliberate change since the base: the vibe skill description is harness-neutral and says it covers
    // every turn, as the operator approved on 2026-11-17. Every other description stays exactly main's.
    const changed: Record<string, [string, string]> = {
      "skills/vibe/SKILL.md": ["working in the Codex Desktop in-app browser.",
        "working in Codex Desktop or Claude Code; it applies to every turn of a vibe session, including mid-session build turns."],
    };
    for (const file of ["skills/vibe/SKILL.md", "agents/vibe-ticket-worker.md", "agents/vibe-environment-worker.md",
      "agents/vibe-requirements-worker.md", "agents/vibe-verify-worker.md", "skills/handoff/SKILL.md"]) {
      const main = description(show(file)) ?? "";
      const [from, to] = changed[file] ?? ["", ""];
      if (from) expect(main, file).toContain(from);
      expect(description(readFileSync(join(dir, file), "utf8")), file).toBe(from ? main.replace(from, to) : main);
    }
  });

  it("gives main's version check command, naming --closedloop and --graph, in the Plugin version section", () => {
    // ISS-13446: a ClosedLoop session must match main on the evals; executive-setup-check-block-first-reply grades
    // `--closedloop connected --graph not-connected`, and a nameless `--connection <name>=<state>` lost it 0/3.
    const version = (text: string) => /^### Plugin version\n([\s\S]*?)^#{2,3} /m.exec(text)?.[1] ?? "";
    const opening = (text: string) => /^Every `\$vibe` start[\s\S]*?never assume either\./m.exec(version(text))?.[0];
    const built = version(builtText("skills/vibe/SKILL.md"));
    expect(built).toContain("`node scripts/plugin-version.mjs check --runtime codex --closedloop <state> --graph <state>`");
    expect(built).toContain("Call ClosedLoop `get-me`\nand closedloop-graph `sync_status` yourself first");
    expect(built).not.toContain("check --runtime codex [--connection");
    const base = "716a5683";
    let main: string;
    try { main = execFileSync("git", ["-C", REPO, "show", `${base}:plugins/vibe/skills/vibe/SKILL.md`], { encoding: "utf8" }); } catch { return; } // A shallow clone has no base commit to compare with.
    expect(opening(builtText("skills/vibe/SKILL.md"))).toBe(opening(main));
  });

  it("binds its bundled provider when installed from a marketplace", async () => {
    const dir = output();
    const home = temp();
    const cache = join(home, "plugins", "cache", "closedloop-ai");
    const version = JSON.parse(readFileSync(join(dir, ".codex-plugin/plugin.json"), "utf8")).version as string;
    mkdirSync(join(cache, "vibe"), { recursive: true });
    symlinkSync(dir, join(cache, "vibe", version));
    // The provider module ships inside the built vibe (lib/ moved there from vibe-core, ISS-14116); load it from the installed copy.
    const core = join(cache, "vibe", version);
    const repo = join(home, "repo");
    write(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    write(join(repo, ".closedloop-ai", "vibe-recipes.json"), JSON.stringify({ schema: 1, provider: "vibe-closedloop-provider" }));
    const provider = await import(pathToFileURL(join(core, "lib/vibe/scripts/provider.mjs")).href);
    const from = pathToFileURL(join(core, "lib/vibe/scripts/provider.mjs")).href;
    const providers = provider.installedProviders({ cwd: repo, from });
    expect(providers.map((one: { name: string; root: string }) => [one.name, one.root])).toEqual([["vibe-closedloop-provider", join(realpathSync(dir), "provider")]]);
    for (const runtime of ["codex", "claude"]) {
      const binding = provider.probeProvider({ runtime, cwd: repo, providers, connections: { tracker: "connected", graph: "connected" } });
      expect(binding.state, runtime).toBe("bound");
      expect(binding.root).toBe(join(realpathSync(dir), "provider"));
      expect(binding.version).toBe(version);
      expect([...binding.capabilities].sort()).toEqual(["graph", "memory", "plans", "recipes", "tickets"]);
      expect(provider.providerPath(binding, "tickets", "ticket-template.md")).toBe(join(realpathSync(dir), "skills/vibe/references/ticket-template.md"));
      expect(lstatSync(provider.providerPath(binding, "tickets", "ticket-template.md")).isFile()).toBe(true);
    }
  });

  it("gives a contract test the text of one built file from the current sources", () => {
    const dir = output();
    for (const file of ["skills/vibe/SKILL.md", "skills/vibe/references/closedloop-environment.md", ".codex-plugin/plugin.json", "provider/provider.json"]) {
      expect(builtText(file), file).toBe(readFileSync(join(dir, file), "utf8"));
    }
  });
});

describe("AC-45 visual QA overflow source", () => {
  it("AC-45 the built visual QA text cites ISS-8422 beside the absolute and sr-only descendant rule, and the generic text does not", () => {
    const built = builtText("skills/vibe/references/quality-loop-visual-qa.md");
    const rule = built.indexOf("trace absolute and sr-only descendants to their");
    expect(rule).toBeGreaterThan(-1);
    const cited = built.indexOf("cite ISS-8422 as the source in that finding.");
    expect(cited).toBeGreaterThan(rule);
    expect(built.slice(rule, cited)).not.toContain("\n## ");
    const generic = readFileSync(join(REPO, "plugins/vibe/skills/vibe/references/quality-loop-visual-qa.md"), "utf8");
    expect(generic).not.toContain("ISS-8422");
  });
});
