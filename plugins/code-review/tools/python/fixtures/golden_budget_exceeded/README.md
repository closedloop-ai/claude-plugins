# golden_budget_exceeded

**Status:** deferred — pending arbitrate-budget integration.

PLN-719 Section 10 listed this fixture but its expected envelope depends
on outputs from arbitrate-budget integration, which has not shipped yet. The directory is
reserved so the future PR just drops `config.yaml`, `inputs/`, and
`expected/` alongside the existing siblings.

The test parametrization in `test_golden_fixtures.py` skips this
fixture via the `_DEFERRED_FIXTURES` map until inputs land.
