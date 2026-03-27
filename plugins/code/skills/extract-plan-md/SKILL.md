---
name: extract-plan-md
description: |
  Sync plan.md with plan.json content. MUST be used after ANY edit to plan.json to keep plan.md in sync.

  Triggers:
  - After editing plan.json with Edit tool (REQUIRED - always sync after edits)
  - User asks to "sync plan.md", "update plan.md", "extract the md from a plan"
  - Converting plan.json to markdown or viewing plan as standalone markdown

  IMPORTANT: Whenever plan.json is modified, plan.md must be updated to match.
---

# Extract Plan MD

Sync plan.md with plan.json content. **Use this skill after ANY edit to plan.json.**

## IMPORTANT: When to Use

**REQUIRED after plan.json edits:**
- After using the Edit tool on plan.json → run this skill to sync plan.md
- After programmatically modifying plan.json content field
- After plan amendments, task status changes, or any plan modifications

**Also use for:**
- User requests to sync/extract/convert plan.json to markdown
- Reviewing a plan outside of the JSON structure
- Sharing the plan with others who don't need the structured JSON fields

## Usage

To sync plan.md with plan.json. The `scripts/` directory is relative to this skill's base directory (shown above as "Base directory for this skill"):

```bash
python3 <base_directory>/scripts/extract.py /path/to/plan.json
```

The script:
1. Reads the plan.json file
2. Extracts the `content` key (which contains the full markdown plan)
3. Fixes any escaped line breaks (`\n` -> actual newlines)
4. Writes to `plan.md` in the same directory as the plan.json

## Examples

**After editing plan.json, sync plan.md:**
```bash
python3 <base_directory>/scripts/extract.py .closedloop-ai/work/plan.json
# Updates .closedloop-ai/work/plan.md to match
```

**Extract from a specific plan:**
```bash
python3 <base_directory>/scripts/extract.py ~/work/plan.json
# Creates/updates ~/work/plan.md
```
