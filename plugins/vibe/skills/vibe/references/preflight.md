# Preflight fixes

Lines that start `> Provider` follow `references/provider-text.md`.

The preflight uses the checkout `--repo` names, else the one the command runs
in, else the one remembered in `~/.codex/vibe/config.json`, and remembers the
one it used there. Any git checkout is accepted. `vibe-sessions.mjs` records
the checkout on each session it creates. Paths can contain spaces
(for example a checkout inside a folder named `Active Work`), so quote every
path in every command.

<!-- generic: hosted-environment -->
The preflight does not check Docker; a repository that needs it says so in
its own docs. `gh` matters because workers push the session's branch and open
pull requests through GitHub.
<!-- end generic: hosted-environment -->
> Provider `recipes` (block `hosted-environment` of `vibe/preflight.md`)

`scripts/vibe-preflight.sh` reports each failure with a `fix` key. Apply the
matching fix below, then re-run the script. Run fixes yourself in the terminal.

Keep the selected preflight arguments on every rerun:

- Preserve `--runtime codex` or `--runtime claude` for the active harness and
  any explicit `--codex` CLI path. Codex otherwise uses its PATH executable or
  the ChatGPT app's bundled CLI, as in the installation guide.
- Common/prototype checks keep `--prototype`, while app preflight omits it. A
  prototype does not need the app's public PostHog key.
- Repo choice and cloning replace the `--repo` path but preserve `--prototype`
  when selected.
- Missing Node uses the ordinary `install-node` fix before the core check can
  run.

Never use Computer Use (`guardrails.md`, "Processes and state"): a dialog
that needs a click is the person's, asked in one plain line. Never type,
store, or ask for a password or token; when an installer asks for the Mac
password, tell the person "Your Mac is asking for your password to finish
installing <thing>; type it in the prompt" and wait.

| fix | What to do |
|---|---|
| `<Codex CLI> plugin add closedloop-core@closedloop-ai` | Stop; never run it (`guardrails.md`, "Plugins and tooling"). A human installs closedloop-core as `INSTALL.md` describes; report the blocker as that section says. |
| `<Codex CLI> plugin add vibe-core@closedloop-ai` | Stop; never run it, as for closedloop-core. A human installs vibe-core (vibe's hooks) and approves its hooks in Codex's `/hooks` as `INSTALL.md` describes; report the blocker the same way. |
| `unsupported-os` | Stop. This flow supports macOS only. Tell the person and engineering. |
| `install-xcode-clt` | `xcode-select --install`, then ask the person to click Install and Agree in the system installer, and wait for it to finish. |
| `install-homebrew` | `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`. It asks for the Mac password through sudo. Afterwards add brew to the shell: `echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"`. |
| `install-node` | The Node that vibe commands actually run (first on PATH, both here and in a new shell) is missing or outside the checkout's `engines` range; the `detail` names the version, its location, and the range. Follow "Supported Node" below. |
| `install-pnpm`, `install-yarn`, `install-bun`, `install-npm` | The checkout's lockfile names that package manager and it is not installed. pnpm: `corepack enable && corepack prepare pnpm@latest --activate`; yarn: `corepack enable && corepack prepare yarn@latest --activate` (inside the repo its `packageManager` field pins the exact version); bun: `brew install oven-sh/bun/bun`; npm ships with Node (`install-node`). |
| `brew-install-jq` | `brew install jq` |
| `brew-install-gh` | `brew install gh`, then apply `gh-auth-login`. |
| `claude-auth-login` | Claude Code only: the `claude` command that runs this session's workers is signed out. Return `NEEDS_PERSON` with exactly: "Your Claude sign-in on this Mac has run out, so I can't start the helpers that build your change. Open the Terminal app (press Cmd and Space, type Terminal, press Return), type claude auth login and press Return, then finish signing in in the browser window that opens. Tell me when you're done." Never give `claude /login` instead: it opens a full Claude session in the Terminal that prints the project's permission rules and asks about project connections. Re-run the preflight once they say they're done. |
| `claude-protected-hook-version` | Claude Code only: the headless writer requires Claude Code 2.1.295 or newer for a failure-blocking protected-write hook. Check the installed CLI version and that the installed vibe guard is a regular file. Update the standalone Claude CLI through its supported updater when needed, without changing any plugin, then rerun the writer preflight. If the guard is missing, diagnose the installed release internally. Preserve the same request and writer; ask the person nothing. |
| `gh-auth-login` | You run it; the person only finishes the GitHub page in the browser. Follow "Signing in to GitHub" below. Never send the person to the Terminal app for it. |
| `ask-for-repo-path` | No git checkout was named, the command does not run in one and none is remembered, or the folder given with `--repo` is not a git checkout. Resolve the active workspace or recorded session internally first. If none is found, ask the person in plain words which project folder to work in ("Which folder holds the project you want to change?"), then rerun with `--repo "<their folder>"`; never clone a copy or guess. |
> Provider `tickets` (block `clone-app` of `vibe/preflight.md`)
> Provider `recipes` (block `posthog-row` of `vibe/preflight.md`)
<!-- generic: bootstrap-row -->
| `install-dependencies` | The checkout has a `package.json` and no installed dependencies. Run the bootstrap the repository documents ("Bootstrap" below); with none documented, install with the package manager its lockfile names (`npm ci` with a `package-lock.json`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`) in the remembered checkout. If it reports missing env values, show the exact names to engineering rather than guessing values. |
<!-- end generic: bootstrap-row -->
> Provider `recipes` (block `bootstrap-row` of `vibe/preflight.md`)

## Bootstrap

The bootstrap is what the repository documents for a fresh checkout or
worktree: the setup steps in its `AGENTS.md`, else its README, else an install
from its lockfile (`install-dependencies` above). With a provider that has
recipes for the repository, its bootstrap wins.

## Supported Node

Install `node@24` when the range accepts 24 (a range such as `>=22`
does), otherwise `node`. Then put it first on PATH for every new
shell, including Codex's non-interactive ones. Each profile file gets one
marked block, appended at the end so it comes after Homebrew's own setup; a
file that already has the marker is left alone:

```bash
brew install node@24
NODE_BIN="$(brew --prefix node@24)/bin"
for f in "$HOME/.zshenv" "$HOME/.zprofile"; do
  touch "$f"
  grep -qF '# vibe: supported Node first' "$f" ||
    printf '\n# vibe: supported Node first\nexport PATH="%s:$PATH"\n' "$NODE_BIN" >> "$f"
done
```

Add the same block to `~/.bash_profile` only if that file already exists.
Do not unlink or remove the old Node; other tools may use it. Re-run the
preflight in a new command: the `node` check must pass, which means both this
shell and a new one run a supported version. Then apply the checkout's `install-<package manager>`
fix if it is now missing.

## Beyond the script

These are checked by the skill, not the script:

> Provider `tickets` (block `mcp-check` of `vibe/preflight.md`)
- Codex Browser plugin: the in-app Browser must be available. If it is not,
  stop; a human adds it (`guardrails.md`, "Plugins and tooling").
- Codex plugin hooks: open `/hooks` and have the person review and trust the
  current vibe hook definition before relying on its PreToolUse refusals.
  Installing the plugin alone does not trust hooks; until a hook has recorded
  the conversation, `plugin-version.mjs loaded` reports `enforced: false` and
  sessions start without the loaded-skill gate. Current official Codex
  hooks documentation confirms Bash and Agent routing but does not establish
  whether `request_user_input` invokes PreToolUse; treat the question guard's
  Codex coverage for that tool as UNVERIFIED, never as a safety gate.

## Commands the sandbox blocks

In Codex's default "Ask for approval" mode a command runs in a sandbox that
can write only inside the workspace and has no network. So `codex mcp add`
fails ("failed to persist config ... Operation not permitted"), and
`codex mcp login`, `gh auth login` and installers fail on the network. The
startup `plugin-version.mjs check` reads the latest release from GitHub and
saves its result under `~/.codex/vibe`, so it fails the same way; it is run
escalated from the first try (`SKILL.md`, section 1, "Plugin version"), with
the justification "Check whether vibe is up to date". Never
hand such a command to the person or send them to the Terminal app. Run the
same command again with your shell tool's escalated permissions
(`sandbox_permissions: "require_escalated"`) and a plain `justification`
that says what it is for, such as "Sign in to GitHub". Codex then shows the person "Allow ChatGPT to run this command?"
with your justification, and runs the command outside the sandbox once they
click Allow once. Request escalation only for the commands this file names.

The other vibe scripts that write under `~/.codex/vibe` are named here too:
`vibe-preflight.sh` (the remembered checkout),
`session-questions.mjs` without `--worktree`, `precedent-check.mjs` without
`--out`, `e2e-lock.mjs` and `image-head.mjs record`. Each prints
`"escalate":true` with its own `justification` when the sandbox refused its
write. Run the same command again escalated with that justification before
going on; never treat the first output as the answer, and never read the
refusal as the script's verdict. Setup does not stop on the remembered
checkout: it is found again on the next run.
In "Full access" mode there is no prompt and the command just runs. This
holds for a spawned worker too: its request reaches the person the same way.

Before dispatching `vibe-setup-worker` for a sign-in on Codex, tell the
<!-- generic: reconnecting -->
person in one line: "I'm reconnecting GitHub for you. If ChatGPT
<!-- end generic: reconnecting -->
> Provider `tickets` (block `reconnecting` of `vibe/preflight.md`)
asks whether it can run a command, click Allow once." If they deny it,
return `BLOCKED` with the command for engineering; never ask again in other
words.

## Restoring a connection

<!-- generic: restore -->
A connection belongs to the bound provider: its text says how to restore
each one (`plugin-version.mjs` printed `bound-disconnected`). With no provider
bound there is nothing to restore.
<!-- end generic: restore -->
> Provider `tickets` (block `restore` of `vibe/preflight.md`)

## Signing in to GitHub

You run every step; the person only finishes the GitHub page in the
browser. Never send them to the Terminal app.

1. Start `gh auth login --hostname github.com --git-protocol https --web` in
   the background, for example
   `nohup gh auth login --hostname github.com --git-protocol https --web > "$HOME/.codex/vibe/gh-sign-in.log" 2>&1 < /dev/null &`,
   requesting escalation as "Commands the sandbox blocks" says when the
   sandbox refuses it. Run without a terminal, it opens no browser: it copies
   a one-time code to the clipboard and its log prints the code and
   `https://github.com/login/device`.
2. Open that page with `open https://github.com/login/device` (escalated the
   same way if refused) and return `NEEDS_PERSON` with exactly: "A GitHub page
   just opened in your browser. Sign in to GitHub there if it asks, enter the
   code <code> (it's already copied), click Authorize, then tell me when you're
   done."
3. When they say they are done, `gh auth status --hostname github.com` must
   pass; otherwise return `BLOCKED` with its output and the log for
   engineering. Then run `gh auth setup-git`. A GitHub sign-in never needs a
   new chat.
