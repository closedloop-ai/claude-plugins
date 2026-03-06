# Agent Definition Format

This document defines the canonical structure for critic/architecture agents in `.claude/agents/`.

## File Structure

All agent definition files must follow this structure:

````markdown
---
name: agent-name
description: One-line description of agent's purpose
model: sonnet
color: blue|green|yellow|orange|purple|red|cyan|pink
tools: Read, Glob, Grep, Skill
skills: code:find-plugin-file
---

## Execution Modes

- **Critic (default fast mode):** Brief description of critic mode behavior

## Inputs

### Critic mode

- List of required input files
- Include standard files: requirements.json, code-map.json, implementation-plan.draft.md, anchors.json, critic-selection.json
- Include domain-specific files

## Outputs

### Critic mode

Write to `reviews/[agent-name].review.json` conforming to `review-delta.schema.json` (use `code:find-plugin-file` skill to locate `schemas/review-delta.schema.json`).

**Note:** The schema accepts both `items` and `review_items` as field names. The `agent` and `mode` fields are optional.

**Example structure:**

```json
{
  "review_items": [
    {
      "anchor_id": "task:example-task",
      "severity": "blocking|major|minor",
      "rationale": "Concrete, domain-specific explanation with evidence",
      "proposed_change": {
        "op": "insert|append|replace",
        "target": "task",
        "path": "task:example-task",
        "value": "Specific enhancement with domain expertise"
      },
      "files": ["path/to/relevant/file.tsx"],
      "ac_refs": ["AC-001"],
      "tags": ["domain-tag-1", "domain-tag-2"]
    }
  ]
}
```
````

**Budget constraints:**

- Review budget from `critic-selection.json`
- Severity ordering: blocking → major → minor
- Drop minor items if over budget

**Quality requirements:**

- All `anchor_id` values must exist in `anchors.json`
- Every item references specific files
- Rationale cites concrete evidence (code patterns, metrics, risks)
- Proposed changes are actionable and domain-specific

## Critic Responsibilities

As [agent role], your responsibilities are organized by domain. Each includes severity classifications for findings.

### 1. [Domain Name 1]

**Blocking:**

- Critical issue that will break production or violate fundamental principles
- Specific examples with measurable criteria (e.g., >200KB, will crash, security vulnerability)

**Major:**

- Important considerations affecting quality, correctness, or best practices
- Specific examples with clear impact

**Minor:**

- Improvements and optimizations
- Nice-to-have enhancements

### 2. [Domain Name 2]

**Blocking:**

- ...

**Major:**

- ...

**Minor:**

- ...

### N. [Domain Name N]

Continue pattern for all responsibility domains (typically 5-7 domains)

## Reference Guidance (all modes)

### Role

Clear statement of agent's expertise and purpose.

Your expertise covers:

- **Area 1**: Specific capabilities
- **Area 2**: Specific capabilities
- **Area N**: Specific capabilities

Brief statement about project-specific context understanding.

### Project Context

**Technology Stack:**

- Key frameworks and versions
- Core libraries and tools
- Platform specifics

**Critical Constraints:**

- Domain-specific constraints
- Performance requirements
- Architectural principles

**Existing Patterns:**

- Current conventions
- Established patterns
- Project standards

**Key Conventions:**

- Critical patterns to follow
- Architectural decisions
- Domain-specific rules

```

---

## Section Guidelines

### 1. Front Matter (YAML)

YAML frontmatter MUST begin on line 1 (the `---` delimiter). No additional YAML fields beyond those listed — schema uses `additionalProperties: false`.

**Required fields:**
- `name`: Kebab-case `[a-z0-9-]+`, matches filename, max 64 chars
- `description`: One-line summary of agent's purpose, max 1024 chars (warn if >200)
- `model`: One of `sonnet`, `opus`, `haiku`, or `inherit`
- `color`: Visual identifier — one of: `red`, `orange`, `yellow`, `green`, `blue`, `cyan`, `purple`, `pink`

**Optional fields:**
- `tools`: Comma-separated inline string of tool names (e.g., `Read, Glob, Grep`). NOT a YAML block array.
- `skills`: Comma-separated inline string of skill identifiers (e.g., `code:find-plugin-file`). NOT a YAML block array. If `skills` is present, `Skill` MUST appear in `tools`.
- `permissionMode`: One of `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`, `ignore`

### 2. Execution Modes

**Purpose:** Define what the agent does in each mode

**Guidelines:**
- Critic mode should be default and primary
- Legacy mode is fallback for comprehensive analysis
- Be specific about output artifacts

### 3. Inputs

**Purpose:** Define required input files for each mode

**Guidelines:**
- Separate by mode (Critic vs Legacy)
- Include standard planning files (requirements.json, code-map.json, etc.)
- Add domain-specific files (e.g., package.json for dependency analysis)
- Be explicit about optional vs required

### 4. Outputs

**Purpose:** Define output format and structure

**Guidelines:**
- **Always include concrete JSON examples** showing review item structure
- Examples should be domain-specific (not generic)
- Include budget constraints section
- Include quality requirements section
- Legacy mode output should be brief

**JSON Example Requirements:**
- Show 2-3 review items covering different severity levels
- Include all fields: anchor_id, severity, rationale, proposed_change, files, ac_refs, tags
- Demonstrate domain expertise in rationale and proposed changes
- Use realistic file paths and task anchors

### 5. Critic Responsibilities

**Purpose:** Define what to look for organized by domain

**Guidelines:**
- Organize by 5-7 responsibility domains
- Each domain has Blocking/Major/Minor severity classifications
- **Blocking:** Critical issues that break production or violate core principles
  - Include specific measurable criteria (e.g., ">200KB", "will crash", "security vulnerability")
  - Focus on actionable, objective issues
- **Major:** Important issues affecting quality, correctness, or best practices
  - Clear impact on user experience or maintainability
- **Minor:** Improvements, optimizations, nice-to-haves
  - Enhancements that make things better but aren't critical

**Domain Examples:**
- TypeScript: Type Safety, Cross-Platform Types, Integration Patterns, etc.
- Performance: Bundle Size, Startup Time, Memory Management, etc.
- Testing: Test Coverage, Cross-Platform Testing, E2E Selection, etc.

### 6. Reference Guidance

**Purpose:** Provide context for all agent operations

**Guidelines:**
- **Role:** Clear statement of agent's expertise and capabilities
  - What is the agent's specialty?
  - What areas of expertise does it cover?
  - How does it relate to the project?
- **Project Context:** Project-specific information
  - Technology stack details
  - Critical constraints
  - Existing patterns and conventions
  - Key project-specific rules

---

## Quality Checklist

Before finalizing an agent definition, verify:

- [ ] Front matter includes all required fields
- [ ] Execution Modes clearly define Critic (default) and Legacy modes
- [ ] Inputs separated by mode and include all necessary files
- [ ] Outputs include concrete JSON examples (not just schema references)
- [ ] JSON examples are domain-specific and realistic
- [ ] Budget constraints section present
- [ ] Quality requirements section present
- [ ] Critic Responsibilities organized into 5-7 clear domains
- [ ] Each domain has Blocking/Major/Minor classifications
- [ ] Blocking items include measurable/objective criteria
- [ ] Reference Guidance includes Role and Project Context
- [ ] No legacy "Task", "Output Format", "Success Criteria", "Error Handling" sections
- [ ] File is under 350 lines (well-organized, no bloat)
- [ ] If `skills` field present, `Skill` is listed in `tools`
- [ ] `tools` and `skills` use comma-separated inline format (not YAML block arrays)
- [ ] Name is kebab-case, max 64 chars; description max 1024 chars

---

## Anti-Patterns to Avoid

**❌ Don't:**
- Include detailed "TWO-PHASE EXECUTION" legacy workflow instructions
- Have duplicate "Inputs" or "Outputs" sections
- Include "Success Criteria", "Error Handling", "Quality Guidelines" sections (legacy)
- Write narrative "Validation Protocol" instead of structured responsibilities
- Use generic examples in JSON output (make them domain-specific)
- Create 10+ responsibility domains (keep it focused at 5-7)
- Mix implementation guidance with responsibility classification

**✅ Do:**
- Keep it concise and actionable
- Focus on critic mode as primary
- Use structured responsibility domains
- Include concrete, domain-specific examples
- Make blocking criteria measurable and objective
- Organize by logical flow: Modes → Inputs → Outputs → Responsibilities → Context

---

## Example Domains by Agent Type

**TypeScript Expert:**
1. Type Safety & Strict Mode Compliance
2. Cross-Platform Type Handling
3. Integration Type Patterns
4. Type Quality & Maintainability
5. Testing & Type Coverage
6. Performance & Compilation

**Test Strategist:**
1. Test Coverage Completeness
2. Cross-Platform Testing Strategy
3. Test Infrastructure & Automation
4. E2E Test Selection & Quality
5. Unit Test Quality & Edge Cases
6. Integration Test Coverage
7. CI/CD & Test Reliability

**Mobile Performance Expert:**
1. Bundle Size Management
2. Startup Time Optimization
3. Memory Management
4. Runtime Performance
5. Metro Bundler Configuration
6. Fast Refresh Compatibility
7. React Native Performance Patterns

---

## Migration Guide

If updating an existing agent from old format:

1. **Remove legacy sections:** Task, Output Format, Success Criteria, Error Handling, Quality Guidelines
2. **Add Execution Modes section** at the top
3. **Reorganize Inputs** by mode (Critic/Legacy)
4. **Enhance Outputs** with concrete JSON examples, budget constraints, quality requirements
5. **Restructure Critic section** from narrative to domain-organized responsibilities
6. **Rename "Role" section** to "Reference Guidance (all modes)" with "Role" and "Project Context" subsections
7. **Verify flow:** Modes → Inputs → Outputs → Responsibilities → Reference Guidance
```
