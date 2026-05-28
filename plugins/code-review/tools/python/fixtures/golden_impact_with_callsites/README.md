# golden_impact_with_callsites

**Status:** deferred — pending plan 06 (external impact).

PLN-719 Section 10 listed this fixture but its expected envelope depends
on outputs from plan 06 (external impact), which has not shipped yet. The directory is
reserved so the future PR just drops `config.yaml`, `inputs/`, and
`expected/` alongside the existing siblings.

The test parametrization in `test_golden_fixtures.py` skips this
fixture via the `_DEFERRED_FIXTURES` map until inputs land.
