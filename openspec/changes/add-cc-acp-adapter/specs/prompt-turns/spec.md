## ADDED Requirements

### Requirement: Prompt turns
`session/prompt` SHALL submit the prompt to the Host Session via the Mod and return when the turn completes, with `stopReason` mapped from the turn's completion reason (`end_turn`, `cancelled`, `max_tokens`, `refusal`).

#### Scenario: Simple turn
- **WHEN** a Client sends a text prompt
- **THEN** it receives `agent_message_chunk` updates and the prompt resolves with `stopReason: "end_turn"`

#### Scenario: Prompt while busy
- **WHEN** a prompt arrives while a turn is running
- **THEN** it is queued and runs after the current turn, as the Reference Adapter does

### Requirement: Streaming updates
The Adapter SHALL stream assistant text as `agent_message_chunk`, thinking as `agent_thought_chunk`, and TodoWrite/Task list changes as `plan` updates.

#### Scenario: Thinking
- **WHEN** the model emits thinking
- **THEN** the Client receives `agent_thought_chunk` updates before the answer text

### Requirement: Tool call reporting
Each tool use SHALL produce a `tool_call` with the Reference Adapter's kind and title mapping and `_meta.claudeCode.toolName`, followed by `tool_call_update` with status `in_progress`, `completed` or `failed`.

#### Scenario: Edit tool
- **WHEN** Claude runs Edit on `src/a.ts`
- **THEN** the Client receives a `tool_call` with kind `edit`, title `Edit src/a.ts`, `_meta.claudeCode.toolName: "Edit"`, then a completed `tool_call_update`

#### Scenario: Diff and terminal content (Tier 2)
- **WHEN** an Edit or Write completes, or a Bash command produces output
- **THEN** the update carries a `diff` block, or terminal output in the Reference Adapter's `_meta` format

### Requirement: Cancellation
`session/cancel` SHALL abort the running turn via `$.turn.abort`, cancel any pending permission request, and resolve the prompt with `stopReason: "cancelled"`.

#### Scenario: Cancel during tool permission
- **WHEN** a Client cancels while a permission request is pending
- **THEN** the permission request is cancelled, the tool is denied, and the prompt resolves `cancelled`

### Requirement: Available commands
The Adapter SHALL send `available_commands_update` built from the Host Session's slash command list, excluding terminal-only commands.

#### Scenario: Session start
- **WHEN** a session is created or loaded
- **THEN** the Client receives `available_commands_update` listing invocable slash commands and skills

### Requirement: History replay
On `session/load` the Adapter SHALL replay the transcript as `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and `tool_call_update` before responding, stripping hidden slash command and local-command markers.

#### Scenario: Load after restart
- **WHEN** a Client loads a session with prior turns
- **THEN** it receives the prior conversation as updates and then the load response including modes

### Requirement: Image and resource prompts (Tier 2)
Image blocks SHALL be written to a session-scoped temp directory and referenced by path in the submitted prompt text; embedded resources and resource links SHALL be inlined or referenced as text.

#### Scenario: Image prompt
- **WHEN** a prompt contains a base64 PNG
- **THEN** the image is written to the session temp dir and the submitted prompt text references its path

### Requirement: Steering (Tier 2)
The Adapter SHALL support `_session/steering` where the Mod can deliver input into a running turn; otherwise it SHALL return "method not found" so Clients fall back to queueing.

#### Scenario: Steering unsupported
- **WHEN** steering is not possible in the installed Claude Code
- **THEN** `_session/steering` returns "method not found"
