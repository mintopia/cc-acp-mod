# Design: cc-acp Adapter

## Context
The Mod runs sandboxed inside Claude Code: no Node, no listening sockets. It can make HTTP requests (including over a Unix socket via `socketPath`), spawn processes, and observe/act through hooks (`turn.step`, `tool.call`, `session.append`, `classic.PermissionRequest`, `$.prompt.submit`, `$.turn.abort`, `$.command.run`, `$.command.list`, `$.session.id`). Hook budgets count only the hook's own CPU time; time awaiting a `$` call is free. `$.prompt.submit` accepts text only and queues until the session is idle.

## Components
- **ACP agent** — stdio JSON-RPC via `@agentclientprotocol/sdk`; maps ACP methods to commands on a session.
- **Session registry** — tracks ACP sessions, Ownership claims, and Host Session state.
- **Socket server** — one Unix socket per session at `$XDG_RUNTIME_DIR/cc-acp/<sessionId>.sock` (macOS: `$TMPDIR/cc-acp/`), mode 0600.
- **tmux controller** — launches Host Sessions on `tmux -L cc-acp`, session name `cc-acp-<sessionId>`; sends keystrokes for control-only gaps.
- **Launch prep** — minimum `claude --version` check; marks the requested cwd trusted in `~/.claude.json`; writes per-session MCP config pointing at the MCP proxy.
- **Transcript replay** — parses `~/.claude/projects/*/<sessionId>.jsonl` into `session/update` notifications.
- **MCP proxy** — stable per-session endpoint forwarding to the currently attached Client's MCP servers.
- **Mod** — bundled plugin; long-polls the socket, executes commands, streams events, bridges permissions, buffers the in-flight turn while detached.

## Adapter ↔ Mod protocol
- Mod → Adapter: `POST /hello {protocolVersion, sessionId, modVersion}` on connect; `GET /poll` (long-poll) returns the next command; `POST /events` with batched events.
- Commands: `prompt {text}`, `cancel`, `set_model {id}`, `run_command {name, args}`, `permission_answer {requestId, decision}`, `report_state`.
- Events: `turn_started`, `chunk {kind: text|thinking|tool, ...}`, `tool_call`, `tool_result`, `permission_request {requestId, ...}`, `mode_changed`, `model_changed`, `commands {list}`, `turn_completed {reason}`, `state {mode, model, busy}`.
- On version mismatch the Adapter treats the Host Session as needing a Revive once idle.

## Decisions
- ADR-0001: interactive CLI in tmux, not the Agent SDK
- ADR-0002: Host Sessions outlive the Adapter; Adapter serves a per-session socket the Mod polls
- ADR-0003: no screen scraping; tmux keystrokes only for control actions
- ADR-0004: Adapter proxies the Client's MCP servers

## Spike findings (issue #2, claude 2.1.293)
Probe Mod loaded via `--plugin-dir`, driven in tmux against a Unix-socket HTTP server.

1. **`--plugin-dir` prompts**: none. The only startup dialog is Claude Code's folder-trust dialog for a never-trusted cwd, shown before the Mod loads; once the cwd is trusted the Mod loads silently. Confirms Launch prep (trust cwd in `~/.claude.json`) and the fail-on-other-dialog rule.
2. **Long-poll over `socketPath`**: works, but `$.http.fetch` hard-aborts at **30s** ("no complete answer within 30000ms"). A poll window MUST be under 30s (25s worked repeatedly, back-to-back, 150s+ total).
3. **`classic.PermissionRequest` waiting minutes**: works. The hook awaited 150s (six chained 25s fetches) and its `{decision:{behavior:'allow'}}` ran the tool ("Allowed by PermissionRequest hook"). The built-in permission dialog renders in the TUI *while the hook is awaiting* and is dismissed when the hook answers. A hook cannot hold one fetch longer than 30s, so it loops short polls.
4. **Permission mode**: readable. `classic.UserPromptSubmit` and `classic.PermissionRequest` carry `permission_mode` (`default` observed); `classic.PreToolUse` does not. Shift+Tab via `tmux send-keys BTab` does cycle modes, but the cycle is NOT fixed: the order and members depend on launch mode and one-time opt-ins (bypass -> auto -> acceptEdits -> plan -> bypass in one run; bypass -> auto -> manual in another; entering auto may show a first-time opt-in dialog). `--permission-mode default` was overridden to bypass by existing user settings. `set_mode` must press, read back, and repeat with a bound, never assume a sequence; the footer text is not a data source (ADR-0003), so read back via the Mod.
5. **`$.prompt.submit` during a dialog**: not lost and not injected into the dialog. It stays pending (its promise resolved ~50s later) and runs as a normal turn once the dialog is resolved and the session idle. Two traps: (a) calling it from inside a `classic.PermissionRequest` hook (even via a timer that hook created) is refused by the host ("would wait on the turn this hook may be holding"); (b) awaiting a long fetch in `session.start` delayed processing of the first typed prompt, so `session.start` must return promptly and run the poll loop detached (`$.clock`).
6. **`$.command.run({command:'model', args:id})`**: works, with caveats. It is queued until the session is idle. Mid-conversation it opens a "Switch model? ... full history gets re-read" confirmation dialog that blocks the call until answered (promise resolved only after Enter), then sets the model. It also **persists the model as the user's default** in `~/.claude/settings.json` ("saved as your default for new sessions"), a side effect on the user's global settings.

### Impact
- Poll window is at most 25s; `session.start` returns immediately (adapter-mod-channel).
- `set_mode` loops with Mod readback (modes-and-models).
- `set_model` is queued, may need a confirmation keystroke, and mutates global settings; prefer the launch-time model (`--model` / `ANTHROPIC_MODEL`) and use `/model` only for mid-session changes (modes-and-models).
- Permission requests loop short polls and tolerate the concurrent TUI dialog (permissions).
- Submit prompts from a later event or a detached timer, never from within a permission hook.
- Not exercised: waits beyond ~150s, hot-reload with `$.state`, and whether the persisted default can be avoided.
