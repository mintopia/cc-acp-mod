# cc-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent for Claude Code. It drives a real interactive `claude` session in tmux instead of the Claude Agent SDK, and bundles a Mod that reports session events back to the Adapter, so nothing is installed into `~/.claude`. It aims to match the feature set of the Reference Adapter (Zed's `claude-agent-acp`). See [ADR-0001](docs/adr/0001-interactive-cli-in-tmux-not-agent-sdk.md) for why it works this way.

## Features

- Sessions: `session/new`, `session/load`, `session/resume`, `session/fork`, `session/list`, `session/close` and `session/delete`.
- Streamed prompts, with text, image, resource link and embedded resource content blocks. Thinking streams separately from the reply, and each turn reports its token usage.
- Steering: send a message mid-turn with the `_session/steering` extension, when the session reports support for it.
- Tool calls with file edits shown as diffs, and Bash output shown as a terminal when the Client supports one.
- Permission requests forwarded to the Client, and `session/set_mode` to switch permission modes.
- Terminal login offered to Clients that support it when Claude Code is not logged in.
- Config options for model, effort (`low` to `max`) and fast mode.
- `AskUserQuestion` answered through the Client's form elicitation support. Without it, the tool is disallowed for the session.
- Client MCP servers (stdio, HTTP and SSE) made available to the session through an Adapter-owned proxy.
- Slash command list, plan, context usage and session title updates sent to the Client.
- Reattach to a still-running Host Session, or Revive one from its saved transcript.

## Requirements

- Node.js 20+
- tmux on `PATH` (Linux and macOS; Windows only via WSL). Without it `session/new` fails saying tmux is required.
- Claude Code 2.1.293 or newer, logged in.

## Quick start

Nothing to install. Run it with:

```sh
npx --yes cc-acp
```

`cc-acp --version` prints the version.

The Adapter speaks ACP over stdio, so it is normally launched by a Client rather than run by hand.

## Client configuration

Point the Client's agent command at `npx --yes cc-acp` (stdio transport).

Harmonic: set the Claude harness command to `npx --yes cc-acp`; no other changes are needed.

Generic ACP Client:

```json
{ "command": "npx", "args": ["--yes", "cc-acp"] }
```

## Configuration

Compatible with the Reference Adapter:

| Variable | Effect |
| --- | --- |
| `CLAUDE_CODE_EXECUTABLE` | `claude` binary to launch (default `claude` on `PATH`) |
| `ANTHROPIC_MODEL` | initial model |
| `CLAUDE_MODEL_CONFIG` | JSON list or map of extra models offered to the Client |
| `CLAUDE_CONFIG_DIR` | Claude Code config directory (default `~/.claude`) |
| `MAX_THINKING_TOKENS` | forwarded to Claude Code |
| `IS_SANDBOX` | allows the bypass-permissions mode when running as root |
| `CC_ACP_IDLE_TIMEOUT_MS` | how long a Host Session with no Owner may sit idle before it is killed and its socket removed. Default `3600000` (1 hour); `0` disables reaping. Sessions mid-turn or awaiting a permission or question answer are never reaped, and a reaped session can be Revived with `session/load` |

All `ANTHROPIC_*` and `CLAUDE_*` variables are forwarded to the Host Session.

## How it works

```
Client <--ACP/stdio--> Adapter <--tmux keystrokes--> Host Session (claude)
                          ^                                |
                          +------ per-session socket ------+
                                    (events from the Mod)
```

- The Adapter is the process the Client launches. It owns the ACP sessions and starts one Host Session per session, an interactive Claude Code running unattended in tmux.
- The Mod is loaded into the Host Session and reports structured events (messages, tool calls, permission requests, questions) over a per-session socket that the Adapter serves ([ADR-0002](docs/adr/0002-adapter-serves-per-session-socket.md)).
- Conversation content and state come only from the Mod. tmux is used to send keystrokes, never to scrape the screen ([ADR-0003](docs/adr/0003-no-screen-scraping.md)).
- The Client's MCP servers are not passed to the Host Session directly. The Adapter exposes a stable proxy endpoint per server and forwards to whatever the currently attached Client supplied, so MCP keeps working after a Reattach ([ADR-0004](docs/adr/0004-adapter-proxies-client-mcp-servers.md)).
- Only one Adapter, the Owner, serves a Host Session at a time. A newer claim displaces the previous Owner.

## Limitations

- Windows is supported only through WSL.
- Changing the model mid-session (`/model`) opens a "Switch model?" confirmation dialog in Claude Code, and the choice is saved as your default model in `~/.claude/settings.json`. See "Spike findings" item 6 in `openspec/changes/add-cc-acp-adapter/design.md`.

## Development

```sh
npm run typecheck
npm test
npm run build
```

### Manual end-to-end suite

`e2e/run.mjs` drives the built Adapter against a real, logged-in `claude` in tmux: initialize, `session/new` with a Client MCP server, a streamed prompt, a tool call, a permission request in default mode, `session/set_mode`, an MCP tool call, then an Adapter restart followed by `session/load` and a prompt that depends on the restored context.

```sh
npm ci
npm run e2e
```

It uses real model turns, so it needs credentials, takes a few minutes and costs tokens. It is not part of `npm test`.

See `GLOSSARY.md` for the terms used here and `docs/adr/` for the design decisions.

## License

[MIT](LICENSE)
