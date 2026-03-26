---
description: "Cancel active ClosedLoop Loop"
allowed-tools: ["Bash(test -f .closedloop-ai/closedloop-loop.local.md:*)", "Bash(rm .closedloop-ai/closedloop-loop.local.md)", "Read(.closedloop-ai/closedloop-loop.local.md)"]
hide-from-slash-command-tool: "true"
---

# Cancel ClosedLoop Loop

To cancel the ClosedLoop loop:

1. Check if `.closedloop-ai/closedloop-loop.local.md` exists using Bash: `test -f .closedloop-ai/closedloop-loop.local.md && echo "EXISTS" || echo "NOT_FOUND"`

2. **If NOT_FOUND**: Say "No active ClosedLoop loop found."

3. **If EXISTS**:
   - Read `.closedloop-ai/closedloop-loop.local.md` to get the current iteration number from the `iteration:` field
   - Remove the file using Bash: `rm .closedloop-ai/closedloop-loop.local.md`
   - Report: "Cancelled ClosedLoop loop (was at iteration N)" where N is the iteration value
