# Verify reviewer premises

Before writing a finding, list every material premise it depends on: source
behavior, tool and CLI behavior, runtime or platform capabilities, and version
support. Verify each premise against its primary source now. Use a code
`file:line` you read, a bounded read-only command with its actual result, or
the current official documentation URL with a short fact from that page.
Training data and an earlier review are not evidence. Label a premise you
cannot verify `UNVERIFIED`; it cannot support a blocking finding.

In structured reviewer output, each finding has `id`, `blocking`, `evidence`,
and `premises`. Each premise is `{claim, evidence}`. Evidence is one of
`{kind:"code", file, line, fact}`, `{kind:"command", command, result}`,
`{kind:"official-doc", url, fact, checkedAt}`, or
`{kind:"UNVERIFIED", reason}`. A blocking finding needs at least one premise,
and every premise must have a verified evidence kind with all fields present.
The receipt gate refuses incomplete blocking findings.

Before endorsing or forwarding a finding, the orchestrator separately checks
each premise against its source. Reopen the cited code line, rerun a safe
read-only command, or check the current official document. A citation's
presence alone does not establish that the claimed behavior follows from it.
Relay only the premises you confirmed; label the rest `UNVERIFIED` and do not
present a finding that depends on them as blocking. Record the recheck in the
review handoff so a later reader can see what was actually checked.
