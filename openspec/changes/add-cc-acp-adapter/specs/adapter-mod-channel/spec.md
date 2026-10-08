## ADDED Requirements

### Requirement: Per-session socket served by the Owner
The Owner SHALL listen on a Unix socket at `$XDG_RUNTIME_DIR/cc-acp/<sessionId>.sock` (falling back to `$TMPDIR/cc-acp/` where `XDG_RUNTIME_DIR` is unset), with permissions 0600.

#### Scenario: Socket permissions
- **WHEN** the Owner creates the socket
- **THEN** only the owning user can connect to it

### Requirement: Mod long-polls for commands and posts events
The Mod SHALL start from `session.start`, send a hello with its protocol version, long-poll the socket for commands, and post events in order.

#### Scenario: Prompt command
- **WHEN** the Adapter enqueues a `prompt` command
- **THEN** the Mod receives it on its next poll and calls `$.prompt.submit`

#### Scenario: Ordered events
- **WHEN** the Mod emits several events during a turn
- **THEN** the Adapter receives them in emission order without loss

### Requirement: Detached buffering
While no Adapter is listening, the Mod SHALL retry with backoff and buffer events for the in-flight turn, delivering them to the next Owner.

#### Scenario: Reconnect mid-turn
- **WHEN** a new Owner starts listening while a turn is in progress
- **THEN** the Mod sends its buffered events for that turn followed by live events

### Requirement: Survive Mod reloads
The Mod SHALL keep connection-critical state in `$.state` so that a hot reload resumes polling without losing pending permission requests.

#### Scenario: Hot reload
- **WHEN** the Mod is reloaded while idle
- **THEN** it reconnects and sends hello again within the startup timeout
