# code plugin changelog

## [1.0.6] - Unreleased

### Changed
- Moved `context-manager-for-judges` agent from `code` plugin to `judges` plugin
- `has_code_changes` now outputs integer count of code files changed; code judges skip condition uses `changed_count -eq 0`
- Documented judge context envelope integration where run-judges maps compressed artifacts into `judge-input.json`.
