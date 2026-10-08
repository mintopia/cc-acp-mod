## ADDED Requirements

### Requirement: Permission bridging
The Mod's `classic.PermissionRequest` hook SHALL forward each permission request to the Adapter and await the answer; the Adapter SHALL send `session/request_permission` with options `allow-once` (kind `allow_once`), `allow-with-updates` (kind `allow_always`) and `reject` (kind `reject_once`).

#### Scenario: Allow once
- **WHEN** the Client selects `allow-once`
- **THEN** the tool runs and no permission rule is added

#### Scenario: Always allow
- **WHEN** the Client selects `allow-with-updates`
- **THEN** the tool runs and the suggested permission rule is applied via `updatedPermissions`

#### Scenario: Reject
- **WHEN** the Client selects `reject` or the request is cancelled
- **THEN** the tool is denied

### Requirement: Unbounded wait for an answer
A pending permission request SHALL wait without timeout; while no Client is attached the Host Session counts as busy, and the request SHALL be re-sent to the next Owner's Client on Reattach.

#### Scenario: Client gone during permission
- **WHEN** the Client disconnects while a permission request is pending and later reloads the session
- **THEN** the Client receives the same permission request again

### Requirement: AskUserQuestion via elicitation
When the Client advertises form elicitation, AskUserQuestion SHALL be presented with `elicitation/create` and the answers returned to Claude.

#### Scenario: Question form
- **WHEN** Claude calls AskUserQuestion with two options
- **THEN** the Client receives a form elicitation with those options and its answer is returned as the tool result
