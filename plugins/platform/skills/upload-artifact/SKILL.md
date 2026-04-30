---
name: upload-artifact
description: |
  Upload a file as a ClosedLoop document (PRD, implementation plan, feature, or template).
  Reads file content and uploads via MCP without consuming conversation context.
  Also supports creating new versions of existing documents.
  Triggers on: "upload artifact", "upload PRD", "upload implementation plan",
  "upload feature", "create artifact from file", "save as artifact",
  "push to closedloop", "new artifact version", "test artifact upload",
  "verify artifact content", "upload to project".
allowed-tools: Bash, Read, AskUserQuestion, mcp__closedloop__create-document, mcp__closedloop__create-document-version, mcp__closedloop__list-projects
---

# Upload Artifact

Upload file content as a ClosedLoop MCP artifact. Two modes:

1. **Script mode** (preferred) — uses a standalone Python script that reads the
   file and calls MCP directly over Streamable HTTP. No conversation context
   consumed for file content. Requires `CLOSEDLOOP_API_KEY` and
   `NEXT_PUBLIC_MCP_SERVER_URL` to already be present in the current shell
   environment.

2. **MCP fallback** — reads the file into context and calls `mcp__closedloop__create-document`
   directly. Uses Claude Code's existing MCP auth. Used when the required
   script-mode environment variables are not available.

## Workflow

Follow these steps in order:

### Step 1: Resolve Credentials and Choose Mode

Read these values from the current shell environment. Do not read, source, or
otherwise rely on a `.env.local` file in the current working directory:
- `CLOSEDLOOP_API_KEY` — the API key (starts with `sk_live_`)
- `NEXT_PUBLIC_MCP_SERVER_URL` — the MCP server URL

**If both exist** → use **script mode** (Steps 2a–5a).
**If either variable is missing** → use **MCP fallback** (Steps 2b–5b).

---

## Script Mode (required env vars available)

### Step 2a: List Projects

Run the script with `--list-projects`:

```bash
uv run --with 'mcp[cli]' <base_directory>/scripts/upload_artifact.py \
  --url "$NEXT_PUBLIC_MCP_SERVER_URL" \
  --api-key "$CLOSEDLOOP_API_KEY" \
  --list-projects
```

Parse the JSON output. Extract the `items` array. Each item has `id` and `name`.

Use `AskUserQuestion` to present the projects to the user:
- Question: "Which project should this artifact be uploaded to?"
- Options: one per project, label = project name, description = project ID

If only one project exists, skip the question and use it automatically.

### Step 3a: Collect Remaining Parameters

Use `AskUserQuestion` to collect any parameters the user hasn't already specified:
- **file_path**: "Which file should be uploaded?"
- **title**: "What title should this document have?"
- **type**: "What type of document?" (options: PRD, IMPLEMENTATION_PLAN, FEATURE, TEMPLATE)

Only ask for parameters the user hasn't already specified. For example, if they
said "upload /tmp/my-prd.txt as a PRD", you already have the file path and
type — only ask for the title.

### Step 4a: Upload via Script

```bash
uv run --with 'mcp[cli]' <base_directory>/scripts/upload_artifact.py \
  --url "$NEXT_PUBLIC_MCP_SERVER_URL" \
  --api-key "$CLOSEDLOOP_API_KEY" \
  --file <FILE_PATH> \
  --title "<TITLE>" \
  --type <TYPE> \
  --project-id <PROJECT_ID>
```

Add `--verify` if the user requested verification or if testing limits.

Add `--artifact-id <ID_OR_SLUG>` instead of `--title`/`--type`/`--project-id`
when creating a new version of an existing document. The flag accepts a UUID
or a user-facing slug (`PRD-*`, `PLN-*`, `FEA-*`); the server resolves it.

### Step 5a: Report Result

Parse the JSON output and report to the user:
- Document slug (e.g. `PLN-376`) and ID
- Content length (characters)
- Upload status
- Verification results (if `--verify` was used)

---

## MCP Fallback (required env vars missing)

### Step 2b: List Projects

Call `mcp__closedloop__list-projects` to get available projects.

Use `AskUserQuestion` to let the user pick a project (skip if only one).

### Step 3b: Collect Remaining Parameters

Same as Step 3a — use `AskUserQuestion` for any missing file_path, title, or type.

### Step 4b: Upload via MCP Tool

Read the file content with the `Read` tool, then call:
- `mcp__closedloop__create-document` for new documents (pass `title`, `type`,
  `content`, and `projectId`). `type` is one of `PRD`, `IMPLEMENTATION_PLAN`,
  `FEATURE`, or `TEMPLATE`.
- `mcp__closedloop__create-document-version` for new versions (pass
  `documentId` and `content`). `documentId` accepts a UUID or a user-facing
  slug (`PRD-*`, `PLN-*`, `FEA-*`).

Note: the file content will be loaded into conversation context in this mode.

### Step 5b: Report Result

Report the document slug (`PRD-*`, `PLN-*`, `FEA-*`) and ID from the MCP tool response.

## Script Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--url` | No | MCP server URL (default: `http://localhost:3010/mcp`) |
| `--api-key` | Yes | ClosedLoop API key (`sk_live_...`) |
| `--list-projects` | No | List projects and exit |
| `--file` | Upload | Path to content file |
| `--title` | Create | Document title |
| `--type` | Create | `PRD`, `IMPLEMENTATION_PLAN`, `FEATURE`, or `TEMPLATE` |
| `--project-id` | No | Project ID or slug (`PRO-*`) |
| `--workstream-id` | No | Workstream ID or slug (`WRK-*`) |
| `--artifact-id` | Version | Existing document ID or slug (`PRD-*`/`PLN-*`/`FEA-*`) for new version |
| `--verify` | No | Fetch back after upload and compare lengths |
