# cc-acp

An Agent Client Protocol agent for Claude Code that drives an interactive Claude Code session instead of the Agent SDK, as a drop-in replacement for Zed's Claude ACP adapter.

## Language

**ACP**:
The Agent Client Protocol: the JSON-RPC protocol between an editor-like client and a coding agent.
_Avoid_: Agent Communication Protocol (a different, unrelated protocol)

**Client**:
The program that speaks ACP to us and presents the conversation to a person, e.g. Harmonic or Zed.
_Avoid_: Frontend, editor, remote

**Reference Adapter**:
Zed's Claude ACP adapter (`claude-agent-acp`), whose feature set we aim to match.
_Avoid_: Zed adapter, claude-code-acp

**Adapter**:
Our ACP agent process: launched by a Client over stdio, it owns ACP sessions and the Host Sessions behind them.
_Avoid_: Agent, server, bridge

**Host Session**:
An interactive Claude Code session running unattended in tmux, which does the actual agent work behind an ACP session.
_Avoid_: Claude process, TUI, backend

**Mod**:
The Claude Code plugin loaded into a Host Session that connects it to the ACP side.
_Avoid_: Plugin, extension, hook

**Reattach**:
Resuming an ACP session by reconnecting to its Host Session that is still running.
_Avoid_: Reconnect

**Revive**:
Resuming an ACP session whose Host Session is gone by starting a new Host Session from its saved transcript.
_Avoid_: Restart, respawn

**Owner**:
The single Adapter currently serving a Host Session. A newer claim on the same session displaces the previous Owner.
_Avoid_: Controller, holder
