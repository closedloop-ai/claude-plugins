---
description: "Run the Claude Design to ClosedLoop pipeline: Stage A inventories a design export zip into schema-validated findings and publishes a platform Design Review document; Stage B is human review; Stage C derives decisions from the edited document and generates DRAFT feature tickets."
argument-hint: <export.zip> [--repo <path>] [--workdir <path>] | --tickets <workdir> --review-doc <FEA-slug> --project <PRO-slug> [--repo <path>]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, TodoWrite, SendMessage
---

Activate the `code:design-inventory` skill and run it with the following arguments: $ARGUMENTS
