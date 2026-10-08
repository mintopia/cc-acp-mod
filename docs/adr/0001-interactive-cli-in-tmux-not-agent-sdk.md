# Drive an interactive Claude Code session in tmux, not the Agent SDK

Anthropic is removing Agent SDK usage from Claude subscriptions, so an ACP adapter built on the SDK (as Zed's `claude-agent-acp` is) would need API billing. We instead back each ACP session with an interactive `claude` running unattended in tmux, bridged by a Claude Code mod, because the interactive CLI remains covered by subscriptions.

## Consequences

- SDK control features (`canUseTool`, `setPermissionMode`, `setModel`, `supportedCommands`, partial-message streaming, session list/fork helpers) have no direct equivalent; each must be rebuilt from mod hooks, slash commands, tmux, or transcript parsing.
- Host Sessions outlive the adapter process, which enables reattaching to a still-running session — something the SDK-based adapter cannot do.
- We depend on the mod API, which is early access and changes between Claude Code releases.
