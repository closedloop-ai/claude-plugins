# Provider text for skills/vibe/references/preflight.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: hosted-environment -->
Vibe sessions run on a Vercel environment, not a local web stack, so the
preflight does not check Docker; `gh` matters because workers push the
session's branch and start its environment through GitHub.
<!-- end: hosted-environment -->

<!-- block: posthog-row -->
| `posthog-key-missing` | Neither the checkout's `apps/app/.env.local` nor the production app's page gave the public PostHog key the flag snapshot needs (`detail` says why; usually no network). Check the Mac is online and re-run the preflight. If it still fails, tell the person "I can't reach the product's analytics settings right now; engineering can help." and show `detail` to engineering. Never ask the person for a key or a Vercel sign-in. |
<!-- end: posthog-row -->

<!-- block: bootstrap-row -->
| `run-loops-setup` | In the remembered checkout (`repo` detail; quote the path, it can contain spaces): `git -C "<repo>" pull --ff-only origin main` only if the working tree is clean, then `cd "<repo>" && ./.closedloop-ai/loops-setup.sh`. If it reports missing env values, show the exact names to engineering rather than guessing values. |
<!-- end: bootstrap-row -->

<!-- block: mcp-check -->
- ClosedLoop MCP: call `get-me`. If it fails, dispatch `vibe-setup-worker`
  to restore the `closedloop` connection as "Restoring a connection" below
  says. Never send the person into the app's Settings to find it.
<!-- end: mcp-check -->

<!-- block: restore -->
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
<!-- end: restore -->

<!-- block: clone-app -->
| `ask-for-repo-path` (the ClosedLoop app) | When the person works on the ClosedLoop app and has no checkout of it yet: `mkdir -p "$HOME/Source" && gh repo clone closedloop-ai/symphony-alpha "$HOME/Source/symphony-alpha"`, run the preflight with `--repo "$HOME/Source/symphony-alpha"` so it is remembered, then apply `run-loops-setup`. |
<!-- end: clone-app -->

<!-- block: reconnecting -->
person in one line: "I'm reconnecting <ClosedLoop|GitHub> for you. If ChatGPT
<!-- end: reconnecting -->
