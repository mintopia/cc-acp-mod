# cc-acp

An [Agent Client Protocol](https://agentclientprotocol.com) agent for Claude Code. It drives a real interactive `claude` session in tmux and bundles a Mod that reports session events back, so nothing is installed into `~/.claude`.

## Requirements

- Node.js 20+
- tmux on `PATH` (Linux and macOS; Windows only via WSL). Without it `session/new` fails saying tmux is required.
- Claude Code 2.1.293 or newer, logged in.

## Installation

Nothing to install. Run it with:

```
npx --yes cc-acp
```

`cc-acp --version` prints the version.

## Client configuration

Point the Client's agent command at `npx --yes cc-acp` (stdio transport).

Harmonic: set the Claude harness command to `npx --yes cc-acp`; no other changes are needed.

Generic ACP Client:

```json
{ "command": "npx", "args": ["--yes", "cc-acp"] }
```

### Environment variables

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

## Manual end-to-end suite

`e2e/run.mjs` drives the built Adapter against a real, logged-in `claude` in tmux: initialize, `session/new` with a Client MCP server, a streamed prompt, a tool call, a permission request in default mode, `session/set_mode`, an MCP tool call, then an Adapter restart followed by `session/load` and a prompt that depends on the restored context.

```
npm ci
npm run e2e
```

It uses real model turns, so it needs credentials, takes a few minutes and costs tokens. It is not part of `npm test`.

## Development

```
npm run typecheck
npm test
```

See `GLOSSARY.md` and `docs/adr/` for the design.
