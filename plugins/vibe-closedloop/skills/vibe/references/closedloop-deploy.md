Steps in this file written for symphony-alpha apply only in a repository that commits `.closedloop-ai/vibe-recipes.json`.

The orchestrator deploys every change in the build loop without being asked:
as soon as the writer finishes a request
(section 5, step 7), commit and deploy it to the session's Vercel preview with
the steps below, then tell the person it's ready to look at. The person no
longer has to say "redeploy"; when they do say "redeploy", "redeploy to
Vercel", "push it up", "put it on Vercel", "let me see it live", or anything
meaning the same, run these same steps.

One deploy runs at a time. Requests that arrive while a deploy is running wait
in the writer's queue until it finishes; then the writer builds every request
that waited, and one deploy after the last of them carries them all. A
"redeploy" said during a running deploy joins that next deploy.

1. Run the matching `codex-sessions` or `claude-sessions` command from step 5 so
   the ticket lists every subagent so far.
2. Keep deployment progress internal; report completion, not technical steps.
   After the writer's quick checks, ROOT commits the checked deliverable
   LOCALLY with the existing commit script and normal hooks, still unpushed. Then the
   publishing helper runs `commit-worktree.mjs --prepare-main-sync`; no
   operational helper regenerates dependencies. Before any remote push
   follow `references/environment.md`, "Main-sync before publication".
3. After preparation and SAME-writer conflict/source correction, ROOT commits
   the staged ordinary merge and any checked fixes (nothing is pushed yet):
   `node scripts/commit-worktree.mjs --worktree "<wt>" --subject "<live ticket slug>: <plain imperative summary of the changes since the last redeploy>" --body "<the screens changed, one per line>"`.
   The subject stays under 72 characters and never mentions AI tools. The
   script leaves out the session's `localFixes` and files that never belong
   in a commit, and the repository's commit hook runs. Add `--exclude <path>`
   for each untracked file the inventory lists as `forbidden` or
   `outsideAllowed` that the session did not write (a person's own files);
   the commit goes ahead without them and without asking anyone to move them. `committed: false`
   means nothing changed; continue. `"ok":false` means the hook refused:
   resume the SAME persistent writer in fix mode with the error, then commit
   again. An existing test or fixture the change broke is repaired there
   (`references/guardrails.md`, "Repair, don't author"). When the writer
   returns `BLOCKED` because a test of live behavior would need changed
   assertions, first check the alternative paths in `references/guardrails.md`,
   "Plugins and tooling". If the block remains, record the exact cause and
   tried paths, then offer the supported pushed handover. Never ask the person
   to repair the test.
4. Dispatch `vibe-environment-worker` in redeploy mode with the worktree, the
   live ticket slug, the session summary, and the session's `localFixes`
   paths. First resume that SAME writer's source-owned `progress` continuation
   to run `main-sync-validate` against committed inputs. The later publisher
   grant carries captured `mainSyncTransactionId`, build purpose and actual
   stdin context. It pushes only the admitted SHA, requests the environment again so that commit is
   deployed, and updates the ticket. The quick checks have run in the
   loop; no tests are authored.
5. On `DONE`, reload the app tab (and the Desktop and Storybook tabs if
   open), look at it yourself, and tell them it's ready to look at, with a
   link to each changed page or component (`references/plain-words.md`,
   "Links to what the person should look at"), naming plainly any acceptance criterion still `not met yet` (section 5,
   step 7). When the session has a reference image, look at each touched
   screen beside it first: a visible difference is not ready, so resume the
   SAME writer with it and redeploy before saying ready. Never say it
   matches the reference when you have seen a gap
   (`references/quality-loop.md`, "The reference check before ready" and
   "What the orchestrator says"). A property the render could not show is
   named as not verified yet; never ask the person to look at or check it.
   Whenever you open
   the Vercel `storybookUrl` and the tab lands on `vercel.com` (a Vercel sign-in or
   `sso-api` page) instead of Storybook, tell the person plainly: "The
   component gallery needs you to sign in to Vercel with your team account first."
   Do not try to get around it. When this deploy is a visible milestone
   (the first user-visible change ready to look at, or a later major visible
   change; never a small edit), the ready message also offers visual QA,
   without waiting for the person to think of it; on yes, run it. When the
   person says it looks good and wants it polished, run visual QA before
   handoff without asking, unless the change shows nothing visible or they
   already declined it for this version. The offer's words, its
   `session-questions.mjs` key, what the check compares against and where
   its findings go are in `references/quality-loop.md`, "Visual QA during the
   session". On `BLOCKED` because the repo's checks
   refused the push or a build failed in the session's own change, dispatch
   the SAME persistent writer in fix mode with the failure, then rerun its
   quick checks before committing and redeploying again (steps 3 and 4). Keep the repair details internal.

Never deploy a change before the writer's quick checks pass.
