---
name: erd-diagram
description: Generate or update an interactive ERD (entity relationship diagram) as a single offline HTML file for a Postgres repository, built only from the repo's schema code (a Prisma schema, a SQL schema dump, or a folder of SQL migrations; other ORMs through a model the agent writes from the code). Two styles, canvas-sidebar (one pannable canvas of every table with a table list) and schema-explorer (overview, focused table view, per-domain diagrams). Use when the user asks for an ERD, a database or schema diagram, a map of tables and relationships, or to refresh an existing ERD file.
argument-hint: "[canvas-sidebar|schema-explorer] [path/to/existing-erd.html]"
---

# ERD diagram

Builds a self-contained, offline HTML ERD from schema code, or updates one this skill made earlier.

**Code only.** Never connect to, query, or test against any database, local or remote, and never start one (no psql, no Docker Postgres). Every fact in the diagram comes from files in the repository.

Arguments: `$ARGUMENTS`

The tool is `scripts/dist/erd.mjs` in this skill's directory. It needs only Node 18 or later, with no install step; the layout engine (elkjs) is bundled into it. Run it as `node <skill-dir>/scripts/dist/erd.mjs <command>`, where `<skill-dir>` is the absolute path of the directory you read this `SKILL.md` from, not the repository you are diagramming.

## 1. Read the arguments

Split `$ARGUMENTS` into words.
- `canvas-sidebar` or `schema-explorer` is the **style**.
- Everything else, joined back with spaces, is the **path** of an existing diagram. Expand a leading `~`.

Then choose the mode:
- **Path given, file missing**: stop. Tell the user the file does not exist and they may have mistyped the path, quoting the path you checked. Do nothing else: no new diagram, no guessing a nearby file.
- **Path given, file exists**: update mode (section 3).
- **No path**: new-diagram mode (section 2).

## 2. New diagram

1. **Style.** If no style was passed, ask with `AskUserQuestion`, one question, header "Style", options:
   - `canvas-sidebar`: "Every table on one pannable, zoomable canvas, with a searchable table list grouped by domain on the left and a detail panel."
   - `schema-explorer`: "Overview of domains, a focused table view (its references on the left, what references it on the right), and a pannable diagram per domain."
2. **Repo.** Use the git root of the current directory. If the user named another repo, pass `--repo <dir>`.
3. **Source.** Run `erd.mjs detect`. It lists Prisma schemas, SQL dumps (`structure.sql`, `schema.sql`) and SQL migration folders, each with its `database`.
   - Only use sources whose `database` is `postgres` or `unknown`; never one marked `sqlite`, `mysql` or another engine.
   - Prefer a Prisma schema (it carries doc comments), then a SQL dump, then a migrations folder.
   - One candidate: use it. Several of the same kind: ask the user which one with `AskUserQuestion`.
   - None: the schema lives in ORM code (Rails `schema.rb`, Django models, TypeORM or Sequelize entities, SQLAlchemy, Drizzle TypeScript without generated SQL, and so on). Read that code and write the model JSON yourself, in the shape described in [the model format](./references/model-format.md). Save it as `~/.claude/erd-diagram/models/<repo-name>.json`, check it with `erd.mjs validate-model <file>`, fix every problem it reports, and use `--source json:<that path>`. Name each model after its table; record a column's database name in `column` and doc comments in `doc`.
4. **Domains.** These group tables in the sidebar, and are the per-domain diagrams in schema-explorer.
   - 20 tables or fewer: skip this step; the build uses one "All tables" group.
   - Otherwise run `erd.mjs draft-domains --source <spec> --out <scratch>/domains.json` and `erd.mjs extract --source <spec> --out <scratch>/model.json`. The draft is a clustering of the foreign-key graph and its names are placeholders. Read the table names, docs and relations in `model.json` and rewrite the draft into roughly 6 to 15 domains named for what they hold ("Billing", "Auth & sessions"), each table in exactly one domain, ids in lowercase-with-dashes. Hub tables that nearly everything references (the build reports them as `hubs`) go with the domain they belong to by meaning, usually accounts or organizations.
5. **Output path.** `~/Desktop/<repo-name>-erd-<style>.html` unless the user named one. If that file already exists, ask whether to update it or write a different name. Never pass `--force` without the user saying to replace it.
6. **Build.** `erd.mjs build --style <style> --out <path> --source <spec> [--domains <file>] [--repo <dir>]`. It refuses an existing `--out` (exit code 3), rejects a domain map that names unknown tables or lists a table twice, and puts any table the map leaves out under "Unsorted".
7. **Verify.** `node <skill-dir>/scripts/dist/verify.mjs <path>` renders the file headlessly (no window). It checks for script errors, that every table renders, that each domain diagram draws, and that search lands on a column. It prints `ok`; fix any failure before reporting. If it prints `skipped` (no puppeteer installed), say the render check was skipped.
8. **Report.** Give the file path, style, source and commit, and the counts of tables, relations and domains. List any `unsorted` tables, and note that the diagram reflects the schema code at that commit, not any running database.

## 3. Update an existing diagram

1. `erd.mjs inspect <path>` shows the file's style, title, source and domains.
   - It errors if the file is not an erd-diagram file; tell the user and stop.
   - A file without an embedded `source` (`legacy: true`) is a diagram made before this skill. `update` finds its source automatically. If it reports several candidates, ask the user which one and pass `--source`.
   - A `json:` source means the model was written by an agent. Regenerate that JSON from the current code first (section 2, step 3, last bullet), then pass `--source json:<path>`.
2. Run `erd.mjs update <path>`, adding `--style <style>` only if the user passed a style different from the file's (that converts it).
   - It re-reads the schema, keeps the file's title and domain map, drops tables that no longer exist, and rewrites the same path.
   - It writes atomically, so a failure leaves the old file untouched.
3. If the result lists `unsorted` tables, they are new. Run `erd.mjs export-domains <path> --out <scratch>/domains.json`, add each new table to the domain it fits (a new domain only if none fits), and run `erd.mjs update <path> --domains <scratch>/domains.json`.
4. Verify as in section 2, step 7.
5. Report what changed: `newTables`, `removedTables`, the source commit, and any style conversion.

## Notes

- Excluded by default: migration bookkeeping tables such as `_prisma_migrations` and `schema_migrations` (the full list is in [the model format](./references/model-format.md)). Pass `build --exclude <regex>` to replace that list.
- A SQL migrations folder is replayed in sorted path order, skipping `down` files and folders. The tool understands CREATE/ALTER/DROP TABLE, columns, constraints, indexes, enums, renames and COMMENT ON, and ignores everything else (functions, triggers, data changes).
- Tables in a schema other than `public` are named `schema:table`.
- Both styles work offline and need no network; data, layout and code are all inside the one file.
- The bundled scripts are built from `tools/erd-diagram/` in the plugin repository; edit the sources there, not `scripts/dist/`.
