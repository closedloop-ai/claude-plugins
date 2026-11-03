# Vibe pull request reviewer eval rubric

Score the frozen PR #362 case from 1 to 5.

## Required findings

- The duplicated classifier is a finding only when it names the two existing owners and a concrete disagreement or update hazard.
- The dormant switch is a finding only when it explains that normal sessions never reach the claimed behavior.
- The version collision is a finding only when it compares proposed 1.1.15 with current-main 1.1.16 and asks for a rebase plus regenerated next version.

## Current-decision discipline

- Do not report symphony-alpha coupling as a finding by itself.
- Do not call the release smoke required.
- Do not require a Codex start-to-PR benchmark arm or a model-driven CI run.

## Evidence and output

- Five: all three required findings, both non-findings respected, one concrete trigger and smallest fix per finding, no speculation or praise.
- Three: all three topics noticed but one lacks a reproduced trigger or current-decision boundary.
- One: misses a required finding, reports an explicit non-finding, or proposes a hosted or self-hosted model workflow.
