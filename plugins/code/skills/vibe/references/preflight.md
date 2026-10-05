# Preflight fixes

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
| `install-node` | `brew install node@24 && brew link --overwrite --force node@24`. Re-check `node --version`. |
| `install-pnpm` | `corepack enable && corepack prepare pnpm@latest --activate`. Inside the repo the `packageManager` field pins the exact version. |
| `brew-install-just` | `brew install just` |
| `brew-install-jq` | `brew install jq` |
| `brew-install-gh` | `brew install gh`, then apply `gh-auth-login`. |
| `gh-auth-login` | `gh auth login --hostname github.com --git-protocol https --web`. It prints a one-time code and opens the browser. Computer Use may paste the code and click Authorize when the person is already signed in to GitHub in that browser; otherwise ask them to sign in there. Then `gh auth setup-git`. |
| `install-docker` | `brew install --cask docker`, then accept the license without a dialog: `sudo /Applications/Docker.app/Contents/MacOS/install --accept-license --user="$USER"` (asks for the Mac password). Then apply `start-docker`. |
| `start-docker` | `docker desktop start` (falls back to `open -a Docker` when the `desktop` subcommand is missing). Poll `docker info` every 5 seconds for up to 3 minutes. If it does not come up, take one screenshot with Computer Use; if a Docker dialog is waiting (sign-in prompt, survey, terms), dismiss or skip it (never sign in on the person's behalf) and keep polling. |
| `clone-repo` | `mkdir -p ~/Source && gh repo clone closedloop-ai/symphony-alpha ~/Source/symphony-alpha`, then apply `run-loops-setup`. |
| `ask-for-repo-path` | The checkout found is not symphony-alpha. Ask where their symphony-alpha folder is, or clone a fresh one with `clone-repo`. |
| `run-loops-setup` | In the main checkout: `git pull --ff-only origin main` only if the working tree is clean, then `./.closedloop-ai/loops-setup.sh`. If it reports missing env values, show the exact names to Daniel Ochoa rather than guessing values. |

## Beyond the script

These are checked by the skill, not the script:

- ClosedLoop MCP: call `get-me`. If it fails, the person needs to connect the
  ClosedLoop connector in Codex Settings; Computer Use may open Settings and
  click Connect, and the person completes sign-in in the browser.
- Codex Browser plugin: the in-app Browser must be available. If it is not,
  open Codex Plugins, add Browser, and continue.
