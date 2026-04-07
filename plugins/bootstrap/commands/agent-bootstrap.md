# Agent Bootstrap Command

Analyzes a codebase and automatically generates a custom suite of **project-specific domain expert agents** tailored to the project.

## Usage

```bash
/agent-bootstrap [options]
```

## Options

### Core Options

- `--target-command <name>` - Target command to generate agents for (default: "code")
- `--depth quick|medium|deep` - Discovery thoroughness level (default: "medium")
  - `quick`: Fast scan, basic detection
  - `medium`: Balanced analysis with pattern recognition
  - `deep`: Comprehensive codebase analysis
- `--focus <area>` - Constrain analysis to specific areas (frontend, backend, infra, mobile, web)
- `--output-dir <path>` - Where to write generated agents (default: `.claude/agents/`)

### Execution Modes

- `--dry-run` - Preview what would be generated without writing files
- `--interactive` - Ask clarifying questions during discovery
- `--update` - Regenerate outdated agents based on project changes
- `--minimal` - Generate only required agents (test-strategist, security-privacy)
- `--enhance` - Run full analysis and generate comprehensive agent suite
- `--add-domain <domain>` - Add agents for specific domain (data-persistence, caching, etc.)

### Conflict Resolution

- `--strategy backup|skip|overwrite|interactive` - How to handle existing agent files
  - `backup` (default): Backup existing files to `.claude/agents/backup-{timestamp}/` before overwriting
  - `skip`: Only generate new agents, skip existing ones
  - `overwrite`: Replace all agents unconditionally (with warning)
  - `interactive`: Prompt for decision on each conflicting agent

## Description

The Agent Bootstrap system is a meta-orchestrator that:

1. **Analyzes your codebase** by reading documentation (CLAUDE.md, README.md, architecture docs)
2. **Identifies domains of work** (not frameworks) - API backend, data persistence, caching, frontend, mobile, etc.
3. **Maps domains to expert agents** based on project complexity and technology choices
4. **Intelligently decomposes** complex agents into specialists where valuable
5. **Generates agent prompts** using LLM expertise (no templates - agents write agents!)

### Core Philosophy

**Not framework detection** → **Expertise domain identification**

Instead of fragile heuristics trying to detect "React + Next.js + Zustand", we:

- Read existing documentation as source of truth
- Identify languages present (simple file counting)
- Identify domains of work (API, data, caching, etc.)
- Map domains to expert agents
- Decompose complex agents into specialists
- Generate prompts using LLM intelligence

### Universal vs Project-Specific Agents

**Bootstrap assumes these universal agents already exist** (NOT generated):

- `prd-analyst` - PRD intake and requirements extraction
- `feature-locator` - Map PRD to codebase locations
- `plan-writer` - Final plan synthesis
- `plan-stager` - Stage planning
- `plan-verifier` - Traceability validation
- `agent-trainer` - Agent learning and improvement

**Bootstrap ALWAYS generates** (required project-specific):

- `test-strategist` - Project-specific testing strategy
- `security-privacy` - Project-specific security & privacy

**Bootstrap conditionally generates** (domain-specific):

- Language experts: `typescript-expert`, `python-pro`, etc.
- Architecture agents: `postgresql-expert`, `react-component-architect`, etc.
- Domain specialists: `caching-strategist`, `auth-security-expert`, etc.

## Workflow Phases

The bootstrap process runs through 8 phases:

### Phase 1: Document Ingestion

Reads CLAUDE.md, README.md, ARCHITECTURE.md, docs/architecture/\*\*, package manifests to understand project context.

**Produces:** `discovery/project-context.md`

### Phase 2: Language & Domain Detection (Parallel)

- **Language Detection**: Counts files by extension (_.ts, _.py, \*.java)
- **Domain Identification**: Analyzes documentation for domain signals

**Produces:** `discovery/languages.json`, `discovery/domains.json`

### Phase 3: Expertise Mapping

Maps detected languages and domains to base expert agent roles.

**Produces:** `synthesis/expert-agents.json`

### Phase 4: Agent Decomposition

Analyzes candidate agents and decides which should be split into specialists based on complexity and breadth. Generates critic-gates.json configuration for the code workflow.

**Produces:** `synthesis/decomposed-agents.json`, `.closedloop-ai/settings/critic-gates.json`

### Phase 5: Pre-Generation Validation

Validates agent specifications before generation.

**Produces:** `synthesis/generation-validation.json`

### Phase 6: Agent Prompt Generation (Fan-out Parallel)

Generates complete agent prompt files using LLM expertise. Runs up to 5 agents in parallel with per-item retry and partial-success thresholds.

**Produces:** `.claude/agents/*.md`, `.closedloop-ai/bootstrap-metadata.json` (durable); working artifacts under `$RUN/...`.

### Phase 7: Agent Prompt Validation

Validates generated prompts for structure, YAML headers, valid colors, and artifact contracts. By default, validation is scoped to the agents listed in `.closedloop-ai/bootstrap-metadata.json`. Use `--legacy` to sweep all agents.

**Produces:** `$RUN/synthesis/agent-validation.json`

### Phase 8: Final Validation

Performs final validation of the complete bootstrap output.

**Produces:** `validation-report.json`, `bootstrap-report.md`

## Output

All working files written to `.closedloop-ai/bootstrap/<timestamp>/` (referenced as `$RUN`):

- `discovery/project-context.md`
- `discovery/languages.json`
- `discovery/domains.json`
- `synthesis/expert-agents.json`
- `synthesis/decomposed-agents.json`
- `synthesis/generation-validation.json`
- `synthesis/agent-validation.json`
- `validation-report.json`
- `bootstrap-report.md`
- `open-questions.md` (if any ambiguities need resolution)

Generated agents written to `.claude/agents/`:

- Project-specific agent files (\*.md)
- `.closedloop-ai/bootstrap-metadata.json` (tracks generated agents for --update mode)

Generated configuration files:

- `.closedloop-ai/settings/critic-gates.json` - Critic selection rules for the code workflow (safe write)

## Examples

### Basic Bootstrap

Generate project-specific agents based on codebase analysis:

```bash
/agent-bootstrap
```

### Dry-run Preview

See what would be generated without writing files:

```bash
/agent-bootstrap --dry-run
```

### Interactive Mode

Get clarifying questions during discovery:

```bash
/agent-bootstrap --interactive
```

### Update Outdated Agents

Regenerate agents affected by project changes:

```bash
/agent-bootstrap --update
```

### Minimal Agent Set

Generate only required agents (test-strategist, security-privacy):

```bash
/agent-bootstrap --minimal
```

### Add Specific Domain

Add agents for a specific domain:

```bash
/agent-bootstrap --add-domain data-persistence
```

### Deep Analysis for Large Codebase

Run comprehensive analysis with deep thoroughness:

```bash
/agent-bootstrap --depth deep
```

### Focus on Backend Only

Constrain analysis to backend domains:

```bash
/agent-bootstrap --focus backend
```

## Configuration

Bootstrap behavior is defined by `commands/agent-bootstrap.json`; generated run state lives under `.closedloop-ai/`, and generated agents are written to `.claude/agents/`.

## Exit Criteria

Bootstrap completes successfully when:

- ✅ project-context.md extracted from documentation
- ✅ Languages and domains detected
- ✅ Agent decomposition decisions made
- ✅ All agents generated with valid structure
- ✅ `test-strategist` present (required)
- ✅ `security-privacy` present (required)
- ✅ Universal agents NOT in generated list
- ✅ Agent prompts validate (proper YAML, valid colors, required sections)
- ✅ Context budgets under recommended limits
- ✅ bootstrap-report.md written with summary

## Error Handling

Bootstrap handles failures gracefully:

**Fatal Errors** (halt immediately):

- Invalid agent specifications
- Missing critical documentation (if no CLAUDE.md or README.md)

**Recoverable Errors** (degraded mode):

- Partial domain detection → generate language experts only
- Some agent generation failed → continue with successful agents
- Validation warnings → report but don't block

**Retryable Errors** (with exponential backoff):

- File read errors
- LLM timeouts during generation
- Transient failures

All errors reported in `bootstrap-report.md` with recommendations for resolution.

## Next Steps

After bootstrap completes:

1. Review generated agents in `.claude/agents/`
2. Check `bootstrap-report.md` for summary and any warnings
3. Answer `open-questions.md` if present
4. Test with: `/code --prd <your-prd.md>`
