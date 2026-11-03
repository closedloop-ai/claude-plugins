/**
 * Command line for erd.mjs.
 *
 *   detect   [--repo DIR]                          list schema sources found in the repo
 *   extract  --source SPEC [--repo DIR] --out F    write the normalized model JSON
 *   validate-model F                               check an agent-written model JSON
 *   draft-domains --source SPEC [--repo DIR] --out F
 *   inspect  FILE                                  style, title, source and domains of a diagram
 *   export-domains FILE --out F                    the domain map embedded in a diagram
 *   build    --style S --out FILE [--source SPEC] [--repo DIR] [--domains F] [--title T] [--exclude RE] [--force]
 *   update   FILE [--style S] [--source SPEC] [--repo DIR] [--domains F] [--title T]
 *
 * SPEC is prisma:<path>, sql:<path> (a schema dump file or a migrations directory) or
 * json:<path> (a model written by hand or by an agent), relative to the repo root.
 *
 * Exit codes: 0 ok, 1 error, 2 usage error or update target missing, 3 build target exists.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Domain, draft, hubs } from "./domains.js";
import {
  build,
  detect,
  ErdError,
  extract,
  inspect,
  loadJson,
  pickSource,
  repoRoot,
  STYLES,
  update,
} from "./erd.js";
import { validateModel } from "./model.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Command {
  options: Record<string, { type: "string" | "boolean" }>;
  positional: number;
  required: string[];
}

const COMMANDS: Record<string, Command> = {
  detect: { options: { repo: { type: "string" } }, positional: 0, required: [] },
  extract: {
    options: { source: { type: "string" }, repo: { type: "string" }, out: { type: "string" } },
    positional: 0,
    required: ["source", "out"],
  },
  "validate-model": { options: {}, positional: 1, required: [] },
  "draft-domains": {
    options: { source: { type: "string" }, repo: { type: "string" }, out: { type: "string" } },
    positional: 0,
    required: ["source", "out"],
  },
  inspect: { options: {}, positional: 1, required: [] },
  "export-domains": { options: { out: { type: "string" } }, positional: 1, required: ["out"] },
  build: {
    options: {
      style: { type: "string" },
      out: { type: "string" },
      source: { type: "string" },
      repo: { type: "string" },
      domains: { type: "string" },
      title: { type: "string" },
      exclude: { type: "string" },
      force: { type: "boolean" },
    },
    positional: 0,
    required: ["style", "out"],
  },
  update: {
    options: {
      style: { type: "string" },
      source: { type: "string" },
      repo: { type: "string" },
      domains: { type: "string" },
      title: { type: "string" },
    },
    positional: 1,
    required: [],
  },
};

class UsageError extends Error {}

type Values = Record<string, string | boolean | undefined>;

function parse(cmd: Command, args: string[]): { values: Values; positionals: string[] } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: cmd.options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const values = parsed.values as Values;
  if (parsed.positionals.length !== cmd.positional) {
    throw new UsageError(`expected ${cmd.positional} positional argument(s), got ${parsed.positionals.length}`);
  }
  for (const key of cmd.required) {
    if (values[key] === undefined) throw new UsageError(`--${key} is required`);
  }
  const style = values.style;
  if (typeof style === "string" && !(STYLES as readonly string[]).includes(style)) {
    throw new UsageError(`--style must be one of ${STYLES.join(", ")}`);
  }
  return { values, positionals: parsed.positionals };
}

function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}

function json(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent);
}

async function dispatch(name: string, values: Values, positionals: string[], templatesDir: string, io: CliIo) {
  const file = positionals[0] ?? "";
  switch (name) {
    case "detect": {
      const root = repoRoot(str(values, "repo"));
      io.out(json({ repo: root, sources: detect(root) }));
      return 0;
    }
    case "extract": {
      const { model } = extract(str(values, "source") ?? "", repoRoot(str(values, "repo")));
      const out = str(values, "out") ?? "";
      writeFileSync(out, json(model, 1), "utf8");
      io.out(JSON.stringify({ out, tables: model.models.length, relations: model.relations.length, hubs: hubs(model) }));
      return 0;
    }
    case "validate-model": {
      const problems = validateModel(loadJson(file));
      io.out(json({ ok: !problems.length, problems }));
      return problems.length ? 1 : 0;
    }
    case "draft-domains": {
      const { model } = extract(str(values, "source") ?? "", repoRoot(str(values, "repo")));
      const domains = draft(model);
      const out = str(values, "out") ?? "";
      writeFileSync(out, json(domains, 1), "utf8");
      io.out(JSON.stringify({ out, domains: domains.map((d) => ({ id: d.id, size: d.tables.length })) }));
      return 0;
    }
    case "inspect": {
      const info = inspect(file);
      const domains = info.domains.map((d) => ({ id: d.id, name: d.name, tables: d.tables.length }));
      io.out(json({ ...info, domains }));
      return 0;
    }
    case "export-domains": {
      const out = str(values, "out") ?? "";
      writeFileSync(out, json(inspect(file).domains, 1), "utf8");
      io.out(out);
      return 0;
    }
    case "build": {
      const out = str(values, "out") ?? "";
      if (existsSync(out) && !values.force) {
        io.err(`error: ${out} already exists; use update to refresh it, or --force to replace it`);
        return 3;
      }
      const root = repoRoot(str(values, "repo"));
      const domainsPath = str(values, "domains");
      const result = await build({
        style: str(values, "style") ?? "",
        out,
        spec: str(values, "source") ?? pickSource(root),
        repo: root,
        templatesDir,
        domainMap: domainsPath ? (loadJson(domainsPath) as Domain[]) : null,
        title: str(values, "title"),
        exclude: str(values, "exclude"),
      });
      io.out(json(result));
      return 0;
    }
    default: {
      if (!existsSync(file) || !statSync(file).isFile()) {
        io.err(`error: ${file} does not exist. Check the path for a typo; nothing was changed.`);
        return 2;
      }
      const result = await update({
        path: file,
        templatesDir,
        style: str(values, "style"),
        spec: str(values, "source"),
        repo: str(values, "repo"),
        domainsPath: str(values, "domains"),
        title: str(values, "title"),
      });
      io.out(json(result));
      return 0;
    }
  }
}

export async function run(argv: string[], templatesDir: string, io: CliIo): Promise<number> {
  const [name = "", ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) {
    io.err(`usage: erd.mjs {${Object.keys(COMMANDS).join(",")}} ...`);
    return 2;
  }
  try {
    const { values, positionals } = parse(cmd, rest);
    return await dispatch(name, values, positionals, templatesDir, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`usage error (${name}): ${e.message}`);
      return 2;
    }
    if (e instanceof ErdError || e instanceof Error) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    io.err(`error: ${String(e)}`);
    return 1;
  }
}
