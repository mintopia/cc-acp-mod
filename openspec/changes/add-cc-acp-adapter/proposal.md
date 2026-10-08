# Change: Add the cc-acp Adapter

## Why
Anthropic is removing Agent SDK usage from Claude subscriptions, so Zed's SDK-based `claude-agent-acp` will require API billing. ACP Clients such as Harmonic need an equivalent agent that runs on the interactive Claude Code CLI, which remains covered by subscriptions (ADR-0001).

## What Changes
- New npm package and binary `cc-acp`: an ACP v1 agent speaking stdio, launched by a Client exactly like the Reference Adapter
- Each ACP session is backed by a Host Session: interactive `claude` in tmux with the bundled Mod loaded via `--plugin-dir`
- Host Sessions outlive the Adapter; `session/load` Reattaches to a live one or Revives a gone one from its transcript
- The Adapter serves a per-session Unix socket that the Mod long-polls for commands and posts events to (ADR-0002)
- Permission prompts, modes, models, slash commands, plans, thinking and tool calls are surfaced over ACP
- The Adapter proxies the Client's MCP servers so credentials stay current across Reattach (ADR-0004)
- Feature scope is tiered: Tier 1 is the MVP (what Harmonic needs); Tier 2 is parity with the Reference Adapter and the definition of done; Tier 3 (JetBrains AIR extensions, providers/gateway auth, ACP v2, native subagent sessions) is out of scope

## Impact
- Affected specs (all new): `acp-agent`, `host-session`, `adapter-mod-channel`, `prompt-turns`, `permissions`, `modes-and-models`, `mcp-proxy`, `session-management`, `packaging`
- Affected code: entire repository (greenfield)
- Clients switch by changing their agent command to `npx --yes @mintopia/cc-acp`
