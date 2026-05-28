# golden_premise_justified

**Status:** deferred — pending PLN-721 (justification / plan 02).

PLN-719 Section 10 listed this fixture but its expected envelope depends
on the `justification` field semantics shipped by plan 02. The fixture
directory is reserved here so the future PR just drops `config.yaml`,
`inputs/`, and `expected/` alongside the existing siblings.

The test parametrization in `test_golden_fixtures.py` skips this fixture
via the `_DEFERRED_FIXTURES` map until inputs land.
