# ISS-13532 original-head replay receipt

This receipt used the merged claude-plugins main commit `208dd8ca63499dee6c34a45857802c33a72c1cee` plus this branch's uncommitted Vibe checks. The symphony-alpha comparison base was its current main commit `0e7bdbb44e113a110c16373984d37da4577d293d`. Each disposable checkout held the exact PR head and that main object. The fixture program verifies the head before reading the diff.

Exact commands run from the claude-plugins repository root:

```sh
node tools/vibe-bench/fixtures/iss-13532-replay.mjs /tmp/iss-13532-replay-9366 0e7bdbb44e113a110c16373984d37da4577d293d 9366 > tools/vibe-bench/fixtures/iss-13532-replay/9366.json
node tools/vibe-bench/fixtures/iss-13532-replay.mjs /tmp/iss-13532-replay-9448 0e7bdbb44e113a110c16373984d37da4577d293d 9448 > tools/vibe-bench/fixtures/iss-13532-replay/9448.json
```

The exact JSON output is in `9366.json` and `9448.json`. Their SHA-256 hashes are `81947a61374bdacce635dd98893691b796654aa22380e0da018712133327c330` and `ffece0879fd173199b5cfe9cbd3c3c2a3c49f61055d446181308a8021c69d6f1`, respectively. PR 9366 selected eight defect-related files and returned 14 diff findings. PR 9448 selected fourteen and returned 19. Both outputs include the false E2E CI claim when web and Desktop E2E are recorded as not run. This is a bounded replay of the original defect paths, not an assertion that every file in either PR was scanned.
