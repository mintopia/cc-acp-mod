## ADDED Requirements

### Requirement: Session list (Tier 2)
`session/list` SHALL return sessions from Claude Code transcripts, filterable by cwd, newest first, paginated with cursors.

#### Scenario: List by cwd
- **WHEN** a Client lists sessions for a cwd
- **THEN** it receives that directory's sessions newest first with titles and timestamps

### Requirement: Resume without replay (Tier 2)
`session/resume` SHALL Reattach or Revive like `session/load` but without replaying history.

#### Scenario: Resume
- **WHEN** a Client resumes a known session
- **THEN** the session becomes usable without history updates being sent

### Requirement: Close and delete (Tier 2)
`session/close` SHALL release Ownership and kill the Host Session; `session/delete` SHALL also remove the transcript.

#### Scenario: Close
- **WHEN** a Client closes a session
- **THEN** the tmux session no longer exists and the socket is removed

### Requirement: Fork (Tier 2)
`session/fork` SHALL create a new session from an existing transcript, launched as a new Host Session.

#### Scenario: Fork
- **WHEN** a Client forks a session
- **THEN** a new session id is returned whose history matches the source

### Requirement: Usage and titles (Tier 2)
The Adapter SHALL emit `usage_update` and `session_info_update` titles as the Reference Adapter does, derived from Mod events and transcripts.

#### Scenario: Usage after turn
- **WHEN** a turn completes
- **THEN** the Client receives a `usage_update` with token usage

### Requirement: Terminal login methods (Tier 2)
The Adapter SHALL advertise the Reference Adapter's terminal auth methods when the Client supports terminal auth, running `claude auth login` variants.

#### Scenario: Not logged in
- **WHEN** Claude Code is not logged in and the Client supports terminal auth
- **THEN** `authMethods` includes a terminal method that runs the Claude login
