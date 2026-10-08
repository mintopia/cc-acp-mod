# cc-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent for Claude Code. It drives a real interactive `claude` session in tmux instead of using the Claude Agent SDK. A bundled Mod reports session events back to the Adapter, so cc-acp installs nothing into `~/.claude`. It aims to match the feature set of the Reference Adapter (Zed's `claude-agent-acp`). See [ADR-0001](docs/adr/0001-interactive-cli-in-tmux-not-agent-sdk.md) for why it works this way.

## Features

- Session methods `session/new`, `session/load`, `session/resume`, `session/fork`, `session/list`, `session/close` and `session/delete`.
- Streamed prompts, with text, image, resource link and embedded resource content blocks. Thinking streams separately from the reply, and each turn reports its token usage.
- Background subagents hold the prompt: when a turn ends while they run, `session/prompt` resolves only after they finish and Claude Code's follow-up turn completes. Subagent tool calls and text are forwarded tagged with `_meta.claudeCode.parentToolUseId`.
- Steering, which sends a message mid-turn through the `_session/steering` extension when the session reports support for it.
- Tool calls with file edits shown as diffs, and Bash output shown as a terminal when the Client supports one.
- Permission requests forwarded to the Client, and `session/set_mode` to switch permission modes.
- Terminal login offered to Clients that support it when Claude Code is not logged in.
- Config options for model, effort (`low` to `max`) and fast mode.
- `AskUserQuestion` answered through the Client's form elicitation support. Without that support, the Adapter disallows the tool for the session.
- Client MCP servers (stdio, HTTP and SSE) made available to the session through an Adapter-owned proxy.
- Slash command list, plan, context usage and session title updates sent to the Client.
- Reattach to a still-running Host Session, or Revive one from its saved transcript.

## Comparison with the Reference Adapter

cc-acp next to the Reference Adapter, `@agentclientprotocol/claude-agent-acp` 0.87.0.

| Feature | `@agentclientprotocol/claude-agent-acp` | cc-acp |
| --- | --- | --- |
| How Claude runs | Claude Agent SDK | Real interactive `claude` in tmux |
| Platform | Node.js | Linux and macOS with tmux; Windows needs WSL |
| Login | Terminal login, plus gateway auth and `logout` | Terminal login only (subscription or Console) |
| Sessions | New, load, resume, fork, list, close, delete | Same |
| `additionalDirectories` | ✓ | ✓ |
| Permission modes | Default, Accept Edits, Plan, Auto, Bypass; `dontAsk` accepted as a default | Default, Accept Edits, Plan, Auto, Bypass |
| Model and effort | Switched live through the SDK | Config options and `session/set_model` (full ids like `claude-sonnet-5-5` map to the matching alias). A model change runs `/model` in the session and confirms its dialog |
| Slash commands | ✓, plus `/mcp` reconnect, enable and disable | ✓ Command list sent to the Client |
| Client MCP servers | stdio, HTTP, SSE, passed to the SDK | stdio, HTTP, SSE, through an Adapter-owned proxy that survives Reattach |
| Permission requests | ✓ | ✓ |
| Terminals | Tool call terminal output | Bash output as a terminal |
| Images and embedded context | ✓ | ✓ |
| Plans and TODOs | ✓ | ✓ |
| Stop reasons | `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` | `end_turn`, `max_tokens`, `refusal`, `cancelled` |
| Steering | ✓ `_session/steering` | ✓ `_session/steering`, when the session supports it |
| Cancellation | ✓ | ✓ |
| Settings | Loaded from user, project and local settings | Claude Code reads its own settings files |
| Mod | None | Bundled. Reports session events and installs nothing in `~/.claude` |
| AIR extensions and native subagent sessions | ✓ | ✗ |

## Requirements

- Node.js 20+
- tmux on `PATH`. Without it, `session/new` fails with an error saying tmux is required.
- Claude Code 2.1.293 or newer, logged in.

## Quick start

Nothing to install. Run it with:

```sh
npx --yes @mintopia/cc-acp
```

`cc-acp --version` prints the version. The Adapter speaks ACP over stdio, so you normally let a Client launch it.

## Client configuration

Set the Client's agent command to `npx --yes @mintopia/cc-acp` with the stdio transport.

For Harmonic, set the Claude harness command to `npx --yes @mintopia/cc-acp`. Nothing else needs changing.

For a generic ACP Client, use:

```json
{ "command": "npx", "args": ["--yes", "@mintopia/cc-acp"] }
```

## Configuration

These variables match the Reference Adapter.

| Variable | Effect |
| --- | --- |
| `CLAUDE_CODE_EXECUTABLE` | `claude` binary to launch (default `claude` on `PATH`) |
| `ANTHROPIC_MODEL` | initial model |
| `CLAUDE_MODEL_CONFIG` | JSON list or map of extra models offered to the Client |
| `CLAUDE_CONFIG_DIR` | Claude Code config directory (default `~/.claude`) |
| `MAX_THINKING_TOKENS` | forwarded to Claude Code |
| `IS_SANDBOX` | allows the bypass-permissions mode when running as root |
| `CC_ACP_IDLE_TIMEOUT_MS` | how long a Host Session with no Owner may sit idle before the Adapter kills it and removes its socket. Default `3600000` (1 hour), and `0` disables reaping. The Adapter never reaps a session that is mid-turn or waiting on a permission or question answer, and `session/load` Revives a reaped session |

The Adapter forwards all `ANTHROPIC_*` and `CLAUDE_*` variables to the Host Session.

## How it works

```
Client <--ACP/stdio--> Adapter <--tmux keystrokes--> Host Session (claude)
                          ^                                |
                          +------ per-session socket ------+
                                    (events from the Mod)
```

- The Adapter is the process the Client launches. It owns the ACP sessions and starts one Host Session per session, an interactive Claude Code running unattended in tmux.
- The Adapter loads the Mod into each Host Session. The Mod reports messages, tool calls, permission requests and questions over a per-session socket that the Adapter serves ([ADR-0002](docs/adr/0002-adapter-serves-per-session-socket.md)).
- Conversation content and state come only from the Mod. The Adapter uses tmux to send keystrokes, never to scrape the screen ([ADR-0003](docs/adr/0003-no-screen-scraping.md)).
- The Adapter does not hand the Client's MCP servers to the Host Session. It exposes a stable proxy endpoint per server and forwards to whatever the currently attached Client supplied, so MCP keeps working after a Reattach ([ADR-0004](docs/adr/0004-adapter-proxies-client-mcp-servers.md)).
- Only one Adapter, the Owner, serves a Host Session at a time. A newer claim displaces the previous Owner.

## Limitations

- cc-acp runs on Linux and macOS. On Windows it needs WSL.
- Changing the model mid-session with `/model` opens a "Switch model?" confirmation dialog in Claude Code, and Claude Code saves the choice as your default model in `~/.claude/settings.json`. See "Spike findings" item 6 in `openspec/changes/add-cc-acp-adapter/design.md`.
- A prompt that starts with a command that opens a panel in Claude Code, such as `/release-notes`, can't be shown to the Client. After 3 seconds the Mod closes the panel and replies that it opens an interactive panel.

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

### Releasing

`develop` is the working branch and `main` holds releases. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `fix:` bumps the patch version, `feat:` the minor version, and `feat!:` or a `BREAKING CHANGE:` footer the major version (minor while below 1.0).

1. Merge `develop` into `main`.
2. release-please opens or updates a release PR on `main` with the version bump and CHANGELOG.
3. Merge the release PR. The Release workflow tags `vX.Y.Z`, creates the GitHub release, publishes `@mintopia/cc-acp` to npm and opens a PR merging `main` back into `develop`.

See [ADR-0005](docs/adr/0005-gitflow-releases-with-release-please.md).

See `GLOSSARY.md` for the terms used here and `docs/adr/` for the design decisions.

## License

[MIT](LICENSE)

MIT License

Copyright (c) 2026 Jessica Smith

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
