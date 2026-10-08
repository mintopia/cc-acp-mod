# Project Context

## Purpose
`cc-acp` is an Agent Client Protocol (ACP) agent for Claude Code. It is a drop-in replacement for Zed's `claude-agent-acp` (the Reference Adapter) that backs each ACP session with an interactive `claude` running unattended in tmux (a Host Session), bridged by a Claude Code mod (the Mod), instead of the Claude Agent SDK. See `GLOSSARY.md` for terms and `docs/adr/` for decisions.

## Tech Stack
- TypeScript on Node, `@agentclientprotocol/sdk`, ACP protocol v1
- The Mod: a Claude Code plugin (TypeScript ES module, `register(on, options)`), loaded via `claude --plugin-dir`
- tmux on a dedicated socket (`tmux -L cc-acp`)

## Conventions
- Content shown to Clients comes only from the Mod; tmux is used for keystrokes, never screen scraping (ADR-0003)
- Behave like the Reference Adapter unless a requirement says otherwise

## Constraints
- No Claude Agent SDK (ADR-0001)
- Linux and macOS; Windows only via WSL
- Mod API is early access; a minimum Claude Code version is enforced

## External Dependencies
- `claude` CLI (`CLAUDE_CODE_EXECUTABLE` or `PATH`), tmux
- Typical Client: Harmonic (https://github.com/mintopia/harmonic)
