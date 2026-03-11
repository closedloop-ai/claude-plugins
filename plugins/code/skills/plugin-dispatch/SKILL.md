---
name: plugin-dispatch
description: Manually dispatch a plugin by name, bypassing gate evaluation. Lists available plugins if no name given.
---

# Plugin Dispatch Skill

This skill enables manual invocation of autonomous workflow plugins.

## Usage

- **List plugins:** `/code:plugin-dispatch` (no arguments)
- **Dispatch plugin:** `/code:plugin-dispatch <plugin-name>`

## Instructions

### Step 1: Resolve environment

Find the plugin root path by reading the closedloop config:

```bash
# Check for CLOSEDLOOP_WORKDIR from session mapping
WORKDIR_CANDIDATES=(
  "$CWD/.closedloop-ai"
  "$CWD/.claude/.closedloop"
)
for candidate in "${WORKDIR_CANDIDATES[@]}"; do
  if [[ -d "$candidate" ]]; then
    CLOSEDLOOP_DIR="$candidate"
    break
  fi
done
```

Resolve `PLUGIN_ROOT` — the root of the `code` plugin distribution. Use the `code:find-plugin-file` skill to locate `scripts/plugin-dispatcher.py` and derive the root from its path.

### Step 2: List or dispatch

**If no plugin name argument is provided:**

Run the dispatcher in list mode:
```bash
python3 "$PLUGIN_ROOT/scripts/plugin-dispatcher.py" \
    --list \
    --plugin-root "$PLUGIN_ROOT" \
    --workdir "$CWD"
```

Parse the JSON output and format as a human-readable table:

| Name | Gate Type | Status | Last Run |
|------|-----------|--------|----------|

**If a plugin name is provided:**

Run the dispatcher in force-dispatch mode:
```bash
python3 "$PLUGIN_ROOT/scripts/plugin-dispatcher.py" \
    --trigger manual \
    --workdir "$CWD" \
    --plugin-root "$PLUGIN_ROOT" \
    --plugin "<name>"
```

Then read the resulting `$CWD/.plugins/dispatch-queue.json` and execute the plugin instructions inline in the current agent context (since this is user-invoked, it runs directly rather than as a background subagent).

### Step 3: Record result

After executing the plugin, record the result to run history:
```bash
echo '{"format_version":1,"plugin":"<name>","result":"success","started_at":"<start_time>","finished_at":"<end_time>","trigger":"manual"}' >> "$CWD/.plugins/run-history.jsonl"
```
