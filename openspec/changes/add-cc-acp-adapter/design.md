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

## Risks / Open Questions (resolved by the spike)
- Does `--plugin-dir` trigger any prompt on an unattended launch?
- Is long-poll `$.http.fetch` to a Unix socket permitted?
- Can a `PermissionRequest` hook wait minutes?
- Can the Mod read the current permission mode; does Shift+Tab cycling work via `send-keys`?
- What happens to `$.prompt.submit` while a built-in dialog is open?
- Does `$.command.run('model', id)` work from the Mod?

If the spike invalidates an assumption, update this design and the affected spec before implementation.
