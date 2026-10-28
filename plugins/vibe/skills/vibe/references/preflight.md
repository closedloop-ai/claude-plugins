# Preflight fixes

The preflight finds the repository's checkout wherever it lives in the home
folder (by its git remote `closedloop-ai/symphony-alpha`, not its folder
name) and remembers it in `~/.codex/vibe/config.json`. Every later run and
`vibe-sessions.mjs` use that remembered checkout. Paths can contain spaces
(for example a checkout inside a folder named `Active Work`), so quote every
path in every command.

Vibe sessions run on a Vercel environment, not a local web stack, so the
preflight does not check Docker; `gh` matters because workers push the
session's branch and start its environment through GitHub.

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
| `unsupported-os` | Stop. This flow supports macOS only. Tell the person and engineering. |
| `install-xcode-clt` | `xcode-select --install`, then ask the person to click Install and Agree in the system installer, and wait for it to finish. |
| `install-homebrew` | `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`. It asks for the Mac password through sudo. Afterwards add brew to the shell: `echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"`. |
| `install-node` | The Node that vibe commands actually run (first on PATH, both here and in a new shell) is missing or outside the checkout's `engines` range; the `detail` names the version, its location, and the range. Follow "Supported Node" below. |
| `install-pnpm` | `corepack enable && corepack prepare pnpm@latest --activate`. Inside the repo the `packageManager` field pins the exact version. |
| `brew-install-jq` | `brew install jq` |
| `brew-install-gh` | `brew install gh`, then apply `gh-auth-login`. |
| `claude-auth-login` | Claude Code only: the `claude` command that runs this session's workers is signed out. Return `NEEDS_PERSON` with exactly: "Your Claude sign-in on this Mac has run out, so I can't start the helpers that build your change. Open the Terminal app (press Cmd and Space, type Terminal, press Return), type claude auth login and press Return, then finish signing in in the browser window that opens. Tell me when you're done." Never give `claude /login` instead: it opens a full Claude session in the Terminal that prints the project's permission rules and asks about project connections. Re-run the preflight once they say they're done. |
| `gh-auth-login` | You run it; the person only finishes the GitHub page in the browser. Follow "Signing in to GitHub" below. Never send the person to the Terminal app for it. |
| `choose-repo` | More than one checkout of the repository was found (the `detail` lists them, separated by a vertical bar). Resolve the active workspace or recorded session through current evidence, then rerun with `--repo "<chosen folder>"`. If it remains ambiguous, return `BLOCKED` internally rather than asking the person a technical checkout question or guessing. |
| `allow-folder-access` | macOS did not let Codex look inside the folders in `detail`. Return `NEEDS_PERSON`: "Your Mac is asking whether Codex can open your <folder> folder; click Allow." If no prompt appears, they allow it in System Settings, Privacy & Security, Files & Folders, under ChatGPT. Then re-run the preflight. Never clone while this is unresolved; the checkout may be in that folder. |
| `clone-repo` | Only when the preflight found no checkout anywhere in the home folder: `mkdir -p "$HOME/Source" && gh repo clone closedloop-ai/symphony-alpha "$HOME/Source/symphony-alpha"`, run the preflight with `--repo "$HOME/Source/symphony-alpha"` so it is remembered, then apply `run-loops-setup`. |
| `ask-for-repo-path` | The folder given with `--repo` is not a checkout of the repository (its git remote is not `closedloop-ai/symphony-alpha`). Resolve the active workspace or recorded checkout internally. Return `BLOCKED` with the evidence if unresolved; never ask a technical folder question or clone another copy while an existing checkout may be present. |
| `posthog-key-missing` | Neither the checkout's `apps/app/.env.local` nor the production app's page gave the public PostHog key the flag snapshot needs (`detail` says why; usually no network). Check the Mac is online and re-run the preflight. If it still fails, tell the person "I can't reach the product's analytics settings right now; engineering can help." and show `detail` to engineering. Never ask the person for a key or a Vercel sign-in. |
| `run-loops-setup` | In the remembered checkout (`repo` detail; quote the path, it can contain spaces): `git -C "<repo>" pull --ff-only origin main` only if the working tree is clean, then `cd "<repo>" && ./.closedloop-ai/loops-setup.sh`. If it reports missing env values, show the exact names to engineering rather than guessing values. |

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

- ClosedLoop MCP: call `get-me`. If it fails, dispatch `vibe-setup-worker`
  to restore the `closedloop` connection as "Restoring a connection" below
  says. Never send the person into the app's Settings to find it.
- Codex Browser plugin: the in-app Browser must be available. If it is not,
  stop; a human adds it (`guardrails.md`, "Plugins and tooling").

## Commands the sandbox blocks

In Codex's default "Ask for approval" mode a command runs in a sandbox that
can write only inside the workspace and has no network. So `codex mcp add`
fails ("failed to persist config ... Operation not permitted"), and
`codex mcp login`, `gh auth login` and installers fail on the network. Never
hand such a command to the person or send them to the Terminal app. Run the
same command again with your shell tool's escalated permissions
(`sandbox_permissions: "require_escalated"`) and a plain `justification`
that says what it is for, such as "Sign in to ClosedLoop" or "Sign in to
GitHub". Codex then shows the person "Allow ChatGPT to run this command?"
with your justification, and runs the command outside the sandbox once they
click Allow once. Request escalation only for the commands this file names.
In "Full access" mode there is no prompt and the command just runs. This
holds for a spawned worker too: its request reaches the person the same way.

Before dispatching `vibe-setup-worker` for a sign-in on Codex, tell the
person in one line: "I'm reconnecting <ClosedLoop|GitHub> for you. If ChatGPT
asks whether it can run a command, click Allow once." If they deny it,
return `BLOCKED` with the command for engineering; never ask again in other
words.

## Restoring a connection

`vibe-setup-worker` runs every command itself. The person only signs in, in
the browser, with their own account, and starts a new chat only when step 5
says so. Never type, paste or ask for a password, code or token, and never
send the person into the app's Settings. The connection is `closedloop` when
`get-me` failed and `closedloop-graph` when `sync_status` failed.

On Codex, `"<codex>"` is the Codex CLI the installation guide uses (`codex`
on PATH, otherwise
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`):

1. Run `"<codex>" mcp list` and read the connection's row, its `Status` and
   `Auth` columns.
2. Choose the command:
   - `closedloop` has no row: `"<codex>" mcp add closedloop --url https://mcp.closedloop.ai/mcp`.
     It opens the ClosedLoop sign-in itself; no `mcp login` follows it.
   - The row's `Auth` is `Not logged in`, or the row is `closedloop` with
     `Auth` `OAuth` (its sign-in may have run out): `"<codex>" mcp login <name>`.
   - `closedloop-graph` has no row, or the row's `Status` is `disabled`:
     return `BLOCKED` with the row for engineering. Its connection details
     come from engineering, never from the person.
   - Anything else: no command; return `DONE` saying so, for step 5.
3. Start the command in the background, so the sign-in page stays open while
   the person reads your message, for example
   `nohup "<codex>" mcp login closedloop > "$HOME/.codex/vibe/sign-in.log" 2>&1 &`,
   requesting escalation as "Commands the sandbox blocks" says when the
   sandbox refuses it. It opens a ClosedLoop sign-in page in the browser.
   Return `NEEDS_PERSON` with exactly: "A ClosedLoop sign-in page just opened
   in your browser. Sign in there with your own ClosedLoop account, then tell
   me when you're done."
4. When the person says they are done, `"<codex>" mcp list` must show the
   row with `Auth` `OAuth`; otherwise return `BLOCKED` with the row and the
   log for engineering. Return `DONE` naming the command that ran (`add` or
   `login`).
5. The orchestrator then finds out whether this chat has the connection.
   Checked on 2026-10-28 against the ChatGPT app's own Codex app server with
   a local sign-in server:
   - After `login` or no command: call `get-me` (or `sync_status`) again in
     this chat. A connection that failed when this chat started reconnects at
     the person's next message, so it usually answers now: carry on, with no
     new chat.
   - It still fails, or the command was `add`: this chat keeps the sign-in
     it started with (a sign-in that ran out while it was open stays broken
     here), and a connection added while a chat is open never reaches that
     chat. Send exactly: "You're connected to ClosedLoop. To use the
     connection, click New chat in the sidebar and type $vibe." Quitting the
     app is not needed. If it still fails in that new chat, return `BLOCKED`
     with the row and the error for engineering.

On Claude Code (checked on 2026-10-28 with Claude Code 2.1.308 the same way),
`claude mcp get <name>` run from the home folder shows the connection's
`Status:` line:

- A conversation that started while the connection needed a sign-in lists
  an `authenticate` tool for it (`mcp__<name>__authenticate`). The
  orchestrator calls it and sends the link it returns with exactly: "Open
  this link to sign in to ClosedLoop with your own ClosedLoop account, then
  tell me when you're done: <link>". Once they sign in, the connection works
  in this same conversation; call `get-me` again and carry on.
- Not configured at all, or anything else: return `BLOCKED` with the
  `Status:` line for engineering. `claude mcp login` needs a terminal, so
  no worker can run it, and a connection added while a conversation is open
  reaches it only after a restart. The smallest one is `/exit` and then
  `claude --continue` in the same folder, which keeps the conversation; never
  `/clear`, which drops it. Never send the person into a settings screen.

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
