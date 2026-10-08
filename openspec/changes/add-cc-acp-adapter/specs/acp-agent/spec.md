## ADDED Requirements

### Requirement: ACP v1 stdio agent
The Adapter SHALL speak ACP protocol version 1 as newline-delimited JSON-RPC over stdio, launched by the Client as a subprocess, and SHALL serve multiple ACP sessions per connection.

#### Scenario: Initialize handshake
- **WHEN** a Client sends `initialize` with `protocolVersion: 1`
- **THEN** the Adapter responds with `protocolVersion: 1`, `agentInfo` naming `cc-acp`, and its agent capabilities

#### Scenario: Unsupported protocol version
- **WHEN** a Client requests a protocol version other than 1
- **THEN** the Adapter responds with protocol version 1 per ACP negotiation rules

### Requirement: Advertised capabilities match implemented features
The Adapter SHALL advertise only capabilities it implements: `loadSession: true`, `promptCapabilities.embeddedContext: true`, `promptCapabilities.image` once image prompts are implemented, `mcpCapabilities` for the MCP transports the proxy supports, and `sessionCapabilities` entries only for implemented session methods.

#### Scenario: Capability gating
- **WHEN** a session method (e.g. `session/fork`) is not implemented
- **THEN** its capability is not advertised and calling it returns JSON-RPC "method not found"

### Requirement: Respect client capabilities
The Adapter SHALL treat any omitted client capability as unsupported and SHALL NOT send `fs/*`, `terminal/*` or `elicitation/create` requests the Client has not advertised.

#### Scenario: Client without elicitation
- **WHEN** the Client does not advertise form elicitation
- **THEN** the Host Session is launched with the AskUserQuestion tool disallowed, as the Reference Adapter does

### Requirement: Session identity
The ACP `sessionId` SHALL equal the Host Session's Claude Code session id, so that the transcript is at `~/.claude/projects/*/<sessionId>.jsonl`.

#### Scenario: Client reads usage from transcripts
- **WHEN** `session/new` returns a `sessionId`
- **THEN** a transcript file named `<sessionId>.jsonl` exists for that session in the standard Claude Code layout

### Requirement: Schema-valid messages
Every message the Adapter sends SHALL validate against the ACP v1 JSON schema.

#### Scenario: Protocol test suite
- **WHEN** the protocol test suite runs the Adapter against a fake Mod
- **THEN** every emitted message validates against the ACP v1 schema
