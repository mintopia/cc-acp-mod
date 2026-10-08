# Tasks

Each task maps to one GitHub issue (child of the epic). "Blocked by" lists task numbers.

## 1. Foundation (Tier 1)
- [ ] 1.1 Spike: validate mod API assumptions — blocked by: none
- [x] 1.2 Tracer bullet: text prompt end-to-end — blocked by: 1.1
- [ ] 1.3 Protocol test harness (fake Mod + ACP schema validation) — blocked by: 1.2
- [ ] 1.4 Thinking, tool calls and plan updates — blocked by: 1.2
- [ ] 1.5 Cancellation and prompt queueing — blocked by: 1.2
- [ ] 1.6 Permission bridging — blocked by: 1.4
- [ ] 1.7 AskUserQuestion via elicitation — blocked by: 1.4
- [ ] 1.8 Modes — blocked by: 1.2
- [x] 1.9 Models — blocked by: 1.2
- [ ] 1.10 Available slash commands — blocked by: 1.2
- [ ] 1.11 session/load with Revive — blocked by: 1.4
- [ ] 1.12 Reattach — blocked by: 1.6, 1.11
- [ ] 1.13 Mod version handshake and skew Revive — blocked by: 1.12
- [ ] 1.14 Idle reaping — blocked by: 1.12
- [ ] 1.15 MCP proxy — blocked by: 1.2
- [ ] 1.16 MCP credentials across Reattach — blocked by: 1.12, 1.15
- [ ] 1.17 Launch hardening — blocked by: 1.2
- [ ] 1.18 Tier 1 done: package and validate with Harmonic — blocked by: 1.3, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.15, 1.17

## 2. Parity (Tier 2)
- [ ] 2.1 Session list, resume, close, delete — blocked by: 1.12
- [ ] 2.2 Fork — blocked by: 1.11
- [ ] 2.3 Usage updates and session titles — blocked by: 1.4
- [ ] 2.4 Image and resource prompts — blocked by: 1.2
- [ ] 2.5 Diffs and terminal output on tool calls — blocked by: 1.4
- [ ] 2.6 Effort and fast config options — blocked by: 1.9
- [x] 2.7 Steering — blocked by: 1.5
- [ ] 2.8 Terminal login methods — blocked by: 1.2
