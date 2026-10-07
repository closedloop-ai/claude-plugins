# Preflight fixes

The preflight finds the symphony-alpha checkout wherever it lives in the home
folder (by its git remote `closedloop-ai/symphony-alpha`, not its folder
name) and remembers it in `~/.codex/vibe/config.json`. Every later run and
`vibe-sessions.mjs` use that remembered checkout. Paths can contain spaces
(for example `~/Documents/Closedloop.ai - Active Work/symphony-alpha`), so
quote every path in every command.

Vibe sessions run on a Vercel environment, not a local web stack, so the
preflight does not check Docker; `gh` matters because workers push the
session's branch and start its environment through GitHub.

`scripts/vibe-preflight.sh` reports each failure with a `fix` key. Apply the
matching fix below, then re-run the script. Run fixes yourself in the terminal.
Use the Codex Computer Use plugin only where a step says so. Never type,
store, or ask for a password or token; when an installer asks for the Mac
password, tell the person "Your Mac is asking for your password to finish
installing <thing>; type it in the prompt" and wait.

| fix | What to do |
|---|---|
| `unsupported-os` | Stop. This flow supports macOS only. Tell the person and Daniel Ochoa. |
| `install-xcode-clt` | `xcode-select --install`, then wait for the system installer to finish. Computer Use may click Install and Agree in that dialog. |
| `install-homebrew` | `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`. It asks for the Mac password through sudo. Afterwards add brew to the shell: `echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"`. |
| `install-node` | The Node that vibe commands actually run (first on PATH, both here and in a new shell) is missing or outside the checkout's `engines` range; the `detail` names the version, its location, and the range. Follow "Supported Node" below. |
| `install-pnpm` | `corepack enable && corepack prepare pnpm@latest --activate`. Inside the repo the `packageManager` field pins the exact version. |
| `brew-install-jq` | `brew install jq` |
| `brew-install-gh` | `brew install gh`, then apply `gh-auth-login`. |
| `gh-auth-login` | `gh auth login --hostname github.com --git-protocol https --web`. It prints a one-time code and opens the browser. Computer Use may paste the code and click Authorize when the person is already signed in to GitHub in that browser; otherwise ask them to sign in there. Then `gh auth setup-git`. |
| `choose-repo` | More than one symphony-alpha checkout was found (the `detail` lists them, separated by a vertical bar). Return `NEEDS_PERSON` asking which folder they work in, listing the folders in plain words. Then run the preflight with `--repo "<chosen folder>"`, which remembers it. |
| `allow-folder-access` | macOS did not let Codex look inside the folders in `detail`. Return `NEEDS_PERSON`: "Your Mac is asking whether Codex can open your <folder> folder; click Allow." If no prompt appears, they allow it in System Settings, Privacy & Security, Files and Folders, under Codex. Then re-run the preflight. Never clone while this is unresolved; the checkout may be in that folder. |
| `clone-repo` | Only when the preflight found no checkout anywhere in the home folder: `mkdir -p "$HOME/Source" && gh repo clone closedloop-ai/symphony-alpha "$HOME/Source/symphony-alpha"`, run the preflight with `--repo "$HOME/Source/symphony-alpha"` so it is remembered, then apply `run-loops-setup`. |
| `ask-for-repo-path` | The folder given with `--repo` is not a symphony-alpha checkout (its git remote is not `closedloop-ai/symphony-alpha`). Ask where their symphony-alpha folder is, or clone a fresh one with `clone-repo`. |
| `posthog-key-missing` | Neither the checkout's `apps/app/.env.local` nor the production app's page gave the public PostHog key the flag snapshot needs (`detail` says why; usually no network). Check the Mac is online and re-run the preflight. If it still fails, tell the person "I can't reach the product's analytics settings right now; Daniel Ochoa can help." and show `detail` to Daniel Ochoa. Never ask the person for a key or a Vercel sign-in. |
| `run-loops-setup` | In the remembered checkout (`repo` detail; quote the path, it can contain spaces): `git -C "<repo>" pull --ff-only origin main` only if the working tree is clean, then `cd "<repo>" && ./.closedloop-ai/loops-setup.sh`. If it reports missing env values, show the exact names to Daniel Ochoa rather than guessing values. |

## Supported Node

Install `node@24` when the range accepts 24 (the default range
`^24 || >=26` does), otherwise `node`. Then put it first on PATH for every new
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
shell and a new one run a supported version. Then apply `install-pnpm` if
`pnpm` is now missing.

## Beyond the script

These are checked by the skill, not the script:

- ClosedLoop MCP: call `get-me`. If it fails, the person needs to connect the
  ClosedLoop connector in Codex Settings; Computer Use may open Settings and
  click Connect, and the person completes sign-in in the browser.
- Codex Browser plugin: the in-app Browser must be available. If it is not,
  open Codex Plugins, add Browser, and continue.
