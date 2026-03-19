# Changelog

## [1.3.1] - 2026-03-19

### Fixed

- `prd-auditor`: Aligned Check 4 and Check 5 with the bundled `prd-template.md` format to eliminate guaranteed false failures on template-conformant PRDs.
  - Check 4 now accepts a standalone `## Out of Scope` section (Pattern B) in addition to a split Scope section with in-scope/out-of-scope subsections (Pattern A). A template-conformant PRD uses Pattern B.
  - Check 5 (Kill Criteria) downgraded from **major** (−0.15) to **minor** (−0.05) finding, since the standard template does not include Kill Criteria. A template-conformant PRD without Kill Criteria now scores 0.95 and passes.
